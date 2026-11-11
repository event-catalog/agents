import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ReviewConfig } from '@/src/config';
import {
  getCatalogProvider,
  getSourcePullRequestInfo,
  type AgentPullRequestStats,
  type CatalogPreflightResult,
} from '@/src/providers';
import type { ImpactPlanResponse, PromptResponse } from '@/src/review-output';
import { describeCatalogChanges, getCatalogFileChanges, type ResourceChange } from '@/src/utils/catalog-changes';
import { resolveCatalogPath } from '@/src/utils/eventcatalog-utils';
import {
  formatPullRequestReference,
  formatResourceChanges,
  listReviewNotes,
  nestHeadings,
  truncate,
} from '@/src/utils/pull-requests/format';

const execFileAsync = promisify(execFile);

export interface CatalogPullRequestResult {
  changedFiles: string[];
  /** The changed files grouped by catalog resource, for the source PR comment. */
  changes: ResourceChange[];
  commitSha?: string;
  pullRequestUrl?: string;
  skipped: boolean;
}

interface CreateCatalogPullRequestInput {
  impactPlan: ImpactPlanResponse;
  result: PromptResponse;
}

const MAX_BODY_RESULT_CHARS = 10000;

/** `env` adds to the process environment, e.g. the catalog provider's credentials for the remote. */
const runGit = async (cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> => {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, ...env },
    maxBuffer: 1024 * 1024 * 20,
  });

  return stdout;
};

const getCatalogChangedFiles = async (catalogPath: string): Promise<string[]> => {
  const status = await runGit(catalogPath, ['status', '--porcelain']);

  return status
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => line.slice(3));
};

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

/** Every catalog branch the agent pushes starts with this, which is how its pull requests are recognised. */
const CATALOG_BRANCH_PREFIX = 'eventcatalog-actions/';

const getCatalogBranchName = (config: ReviewConfig): string => {
  const source = getSourcePullRequestInfo(config);
  const sourceRepo = source ? source.repositorySlug : 'local';
  const sourcePr = source ? `pr-${source.number}` : 'review';

  return `${CATALOG_BRANCH_PREFIX}${slugify(sourceRepo)}/${slugify(sourcePr)}`;
};

export const formatCatalogPullRequestBody = (
  config: Pick<ReviewConfig, 'github' | 'pullRequestState'> & Partial<Pick<ReviewConfig, 'azureDevOps' | 'bitbucket'>>,
  changes: ResourceChange[],
  input: CreateCatalogPullRequestInput
): string => {
  const sourcePullRequest = getSourcePullRequestInfo(config)?.url;
  const link = sourcePullRequest ? `[${formatPullRequestReference(sourcePullRequest)}](${sourcePullRequest})` : undefined;
  // Run on merge, the source PR is done; run on an open PR, each new push to it updates this one.
  const origin =
    config.pullRequestState === 'merged'
      ? `after ${link ?? 'a source code change'} was merged. Review it like any other pull request before merging.`
      : `for ${link ?? 'a source code change'}. Review it like any other pull request before merging; pushing a new commit to the source pull request updates it.`;
  const notes = listReviewNotes(input.impactPlan);
  const summary = nestHeadings(truncate(input.result.prSummary.trim(), MAX_BODY_RESULT_CHARS), 3);

  return `> [!NOTE]
> Opened by [EventCatalog Agents](https://github.com/event-catalog/agents) ${origin}

## Changes

${formatResourceChanges(changes)}

## Summary

${summary || 'No summary was returned.'}
${notes.length > 0 ? `\n## Worth checking\n\n${notes.map((note) => `- ${note}`).join('\n')}\n` : ''}`;
};

export const preflightCatalogPullRequestAccess = async (config: ReviewConfig): Promise<CatalogPreflightResult> => {
  const result = await getCatalogProvider(config).preflight(config.catalogRef);
  console.error(`[eventcatalog:catalog-pr] Catalog preflight passed for ${result.fullName}@${config.catalogRef}`);
  return result;
};

export const createOrUpdateCatalogPullRequest = async (
  config: ReviewConfig,
  input: CreateCatalogPullRequestInput
): Promise<CatalogPullRequestResult> => {
  if (!config.catalogRepo) {
    console.error('[eventcatalog:catalog-pr] No catalog repository configured; skipping catalog pull request.');
    return { changedFiles: [], changes: [], skipped: true };
  }

  if (!config.catalogToken) {
    throw new Error('A catalog token is required to push EventCatalog documentation changes.');
  }

  const catalog = getCatalogProvider(config);

  const catalogPath = resolveCatalogPath(config);
  const changedFiles = await getCatalogChangedFiles(catalogPath);

  if (changedFiles.length === 0) {
    console.error('[eventcatalog:catalog-pr] No EventCatalog changes found; skipping catalog pull request.');
    return { changedFiles: [], changes: [], skipped: true };
  }

  const changes = describeCatalogChanges(await getCatalogFileChanges(catalogPath));

  const branchName = getCatalogBranchName(config);
  const source = getSourcePullRequestInfo(config);
  const commitMessage = source ? `Update EventCatalog docs for ${source.reference}` : 'Update EventCatalog docs';
  const remoteEnv = catalog.gitEnv();

  await runGit(catalogPath, ['config', 'user.name', 'eventcatalog-actions[bot]']);
  await runGit(catalogPath, ['config', 'user.email', 'eventcatalog-actions[bot]@users.noreply.github.com']);
  await runGit(catalogPath, ['checkout', '-B', branchName]);
  await runGit(catalogPath, ['add', '-A']);
  await runGit(catalogPath, ['commit', '-m', commitMessage]);
  await runGit(catalogPath, ['fetch', 'origin', branchName], remoteEnv).catch(() => undefined);
  await runGit(catalogPath, ['push', '--force-with-lease', 'origin', `HEAD:${branchName}`], remoteEnv);

  const commitSha = (await runGit(catalogPath, ['rev-parse', 'HEAD'])).trim();
  const title = input.result.prTitle || commitMessage;
  const body = formatCatalogPullRequestBody(config, changes, input);
  const pullRequestUrl = await catalog.upsertPullRequest({ branch: branchName, base: config.catalogRef, title, body });

  return { changedFiles, changes, commitSha, pullRequestUrl, skipped: false };
};

/**
 * Counts the agent's pull requests in the catalog repository (recognised by branch name) among the
 * 100 most recent. Reads only pull request states and dates, nothing about their content.
 */
export const getAgentPullRequestStats = async (config: ReviewConfig): Promise<AgentPullRequestStats | undefined> => {
  if (!config.catalogRepo || !config.catalogToken) return undefined;
  return getCatalogProvider(config).getAgentPullRequestStats(CATALOG_BRANCH_PREFIX);
};
