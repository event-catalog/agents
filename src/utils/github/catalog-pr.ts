import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Octokit } from 'octokit';
import type { ReviewConfig } from '@/src/config';
import type { ImpactPlanResponse, PromptResponse } from '@/src/review-output';
import { describeCatalogChanges, getCatalogFileChanges, type ResourceChange } from '@/src/utils/catalog-changes';
import { resolveCatalogPath } from '@/src/utils/eventcatalog-utils';
import {
  formatPullRequestReference,
  formatResourceChanges,
  listReviewNotes,
  nestHeadings,
  truncate,
} from '@/src/utils/github/format';

const execFileAsync = promisify(execFile);

export interface CatalogPullRequestResult {
  changedFiles: string[];
  /** The changed files grouped by catalog resource, for the source PR comment. */
  changes: ResourceChange[];
  commitSha?: string;
  pullRequestUrl?: string;
  skipped: boolean;
}

export interface CatalogPreflightResult {
  branchSha: string;
  fullName: string;
}

interface CreateCatalogPullRequestInput {
  impactPlan: ImpactPlanResponse;
  result: PromptResponse;
}

type RequestErrorLike = Error & {
  status?: number;
};

const MAX_BODY_RESULT_CHARS = 10000;

const parseRepository = (repository: string | undefined): { owner: string; repo: string } | undefined => {
  const [owner, repo] = (repository ?? '').split('/');

  if (!owner || !repo) {
    return undefined;
  }

  return { owner, repo };
};

const isRequestErrorLike = (error: unknown): error is RequestErrorLike => error instanceof Error && 'status' in error;

const formatRequestError = (error: unknown, fallback: string): Error => {
  if (!isRequestErrorLike(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  return new Error(`${fallback}: ${error.message}`);
};

const runGit = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
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
  const sourceRepo = config.github ? `${config.github.owner}-${config.github.repo}` : 'local';
  const sourcePr = config.github ? `pr-${config.github.prNumber}` : 'review';

  return `${CATALOG_BRANCH_PREFIX}${slugify(sourceRepo)}/${slugify(sourcePr)}`;
};

export const formatCatalogPullRequestBody = (
  config: Pick<ReviewConfig, 'github' | 'pullRequestState'>,
  changes: ResourceChange[],
  input: CreateCatalogPullRequestInput
): string => {
  const sourcePullRequest = config.github
    ? `https://github.com/${config.github.owner}/${config.github.repo}/pull/${config.github.prNumber}`
    : undefined;
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
  const catalogRepository = parseRepository(config.catalogRepo);

  if (!catalogRepository) {
    throw new Error('A catalog repository in owner/repo format is required.');
  }

  if (!config.catalogToken) {
    throw new Error('A catalog token is required to access the EventCatalog repository.');
  }

  const octokit = new Octokit({ auth: config.catalogToken });
  const { owner, repo } = catalogRepository;

  let repository: Awaited<ReturnType<typeof octokit.rest.repos.get>>['data'];
  let branch: Awaited<ReturnType<typeof octokit.rest.repos.getBranch>>['data'];

  try {
    const response = await octokit.rest.repos.get({ owner, repo });
    repository = response.data;
  } catch (error) {
    throw formatRequestError(error, `Catalog token cannot access ${owner}/${repo}`);
  }

  try {
    const response = await octokit.rest.repos.getBranch({
      owner,
      repo,
      branch: config.catalogRef,
    });
    branch = response.data;
  } catch (error) {
    throw formatRequestError(error, `Catalog ref "${config.catalogRef}" was not found in ${owner}/${repo}`);
  }

  console.error(`[eventcatalog:catalog-pr] Catalog preflight passed for ${repository.full_name}@${config.catalogRef}`);

  return {
    branchSha: branch.commit.sha,
    fullName: repository.full_name,
  };
};

export const createOrUpdateCatalogPullRequest = async (
  config: ReviewConfig,
  input: CreateCatalogPullRequestInput
): Promise<CatalogPullRequestResult> => {
  const catalogRepository = parseRepository(config.catalogRepo);

  if (!catalogRepository) {
    console.error('[eventcatalog:catalog-pr] No catalog repository configured; skipping catalog pull request.');
    return { changedFiles: [], changes: [], skipped: true };
  }

  if (!config.catalogToken) {
    throw new Error('A catalog token is required to push EventCatalog documentation changes.');
  }

  const catalogPath = resolveCatalogPath(config);
  const changedFiles = await getCatalogChangedFiles(catalogPath);

  if (changedFiles.length === 0) {
    console.error('[eventcatalog:catalog-pr] No EventCatalog changes found; skipping catalog pull request.');
    return { changedFiles: [], changes: [], skipped: true };
  }

  const changes = describeCatalogChanges(await getCatalogFileChanges(catalogPath));

  const branchName = getCatalogBranchName(config);
  const commitMessage = config.github
    ? `Update EventCatalog docs for ${config.github.owner}/${config.github.repo}#${config.github.prNumber}`
    : 'Update EventCatalog docs';

  await runGit(catalogPath, ['config', 'user.name', 'eventcatalog-actions[bot]']);
  await runGit(catalogPath, ['config', 'user.email', 'eventcatalog-actions[bot]@users.noreply.github.com']);
  await runGit(catalogPath, ['checkout', '-B', branchName]);
  await runGit(catalogPath, ['add', '-A']);
  await runGit(catalogPath, ['commit', '-m', commitMessage]);
  await runGit(catalogPath, ['fetch', 'origin', branchName]).catch(() => undefined);
  await runGit(catalogPath, ['push', '--force-with-lease', 'origin', `HEAD:${branchName}`]);

  const commitSha = (await runGit(catalogPath, ['rev-parse', 'HEAD'])).trim();
  const octokit = new Octokit({ auth: config.catalogToken });
  const { owner, repo } = catalogRepository;
  const title = input.result.prTitle || commitMessage;
  const body = formatCatalogPullRequestBody(config, changes, input);
  const head = `${owner}:${branchName}`;
  const { data: existingPullRequests } = await octokit.rest.pulls.list({
    owner,
    repo,
    head,
    base: config.catalogRef,
    state: 'open',
    per_page: 10,
  });

  const existingPullRequest = existingPullRequests[0];

  if (existingPullRequest) {
    const { data } = await octokit.rest.pulls.update({
      owner,
      repo,
      pull_number: existingPullRequest.number,
      title,
      body,
    });

    console.error(`[eventcatalog:catalog-pr] Updated catalog pull request: ${data.html_url}`);
    return { changedFiles, changes, commitSha, pullRequestUrl: data.html_url, skipped: false };
  }

  const { data } = await octokit.rest.pulls.create({
    owner,
    repo,
    head: branchName,
    base: config.catalogRef,
    title,
    body,
  });

  console.error(`[eventcatalog:catalog-pr] Created catalog pull request: ${data.html_url}`);
  return { changedFiles, changes, commitSha, pullRequestUrl: data.html_url, skipped: false };
};

/** How the agent's catalog pull requests have fared: the signal for whether its work gets merged. */
export interface AgentPullRequestStats {
  open: number;
  merged30d: number;
  closedUnmerged30d: number;
}

/**
 * Counts the agent's pull requests in the catalog repository (recognised by branch name) among the
 * 100 most recently updated. Reads only pull request states and dates, nothing about their content.
 */
export const getAgentPullRequestStats = async (config: ReviewConfig): Promise<AgentPullRequestStats | undefined> => {
  const catalogRepository = parseRepository(config.catalogRepo);
  if (!catalogRepository || !config.catalogToken) return undefined;

  const octokit = new Octokit({ auth: config.catalogToken });
  const { data } = await octokit.rest.pulls.list({
    ...catalogRepository,
    state: 'all',
    sort: 'updated',
    direction: 'desc',
    per_page: 100,
  });

  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recent = (date: string | null) => Boolean(date && Date.parse(date) >= since);
  const agentPullRequests = data.filter((pullRequest) => pullRequest.head.ref.startsWith(CATALOG_BRANCH_PREFIX));

  return {
    open: agentPullRequests.filter((pullRequest) => pullRequest.state === 'open').length,
    merged30d: agentPullRequests.filter((pullRequest) => recent(pullRequest.merged_at)).length,
    closedUnmerged30d: agentPullRequests.filter((pullRequest) => !pullRequest.merged_at && recent(pullRequest.closed_at)).length,
  };
};
