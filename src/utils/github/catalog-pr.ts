import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Octokit } from 'octokit';
import type { ReviewConfig } from '@/src/config';
import type { PromptResponse } from '@/src/review-output';
import { resolveCatalogPath } from '@/src/utils/eventcatalog-utils';

const execFileAsync = promisify(execFile);

export interface CatalogPullRequestResult {
  changedFiles: string[];
  commitSha?: string;
  pullRequestUrl?: string;
  skipped: boolean;
}

export interface CatalogPreflightResult {
  branchSha: string;
  fullName: string;
}

interface CreateCatalogPullRequestInput {
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

const getCatalogBranchName = (config: ReviewConfig): string => {
  const sourceRepo = config.github ? `${config.github.owner}-${config.github.repo}` : 'local';
  const sourcePr = config.github ? `pr-${config.github.prNumber}` : 'review';

  return `eventcatalog-actions/${slugify(sourceRepo)}/${slugify(sourcePr)}`;
};

const truncate = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n\n...truncated`;
};

const formatCatalogPullRequestBody = (config: ReviewConfig, catalogChangedFiles: string[], result: PromptResponse): string => {
  const sourcePullRequest = config.github
    ? `https://github.com/${config.github.owner}/${config.github.repo}/pull/${config.github.prNumber}`
    : undefined;
  const catalogFiles = catalogChangedFiles.map((file) => `- \`${file}\``).join('\n');

  return `## Summary

${truncate(result.prSummary, MAX_BODY_RESULT_CHARS)}

${sourcePullRequest ? `Source pull request: ${sourcePullRequest}\n` : ''}
## Catalog Files Changed

${catalogFiles || '- No catalog files listed'}
`;
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
    return { changedFiles: [], skipped: true };
  }

  if (!config.catalogToken) {
    throw new Error('A catalog token is required to push EventCatalog documentation changes.');
  }

  const catalogPath = resolveCatalogPath(config);
  const changedFiles = await getCatalogChangedFiles(catalogPath);

  if (changedFiles.length === 0) {
    console.error('[eventcatalog:catalog-pr] No EventCatalog changes found; skipping catalog pull request.');
    return { changedFiles: [], skipped: true };
  }

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
  const body = formatCatalogPullRequestBody(config, changedFiles, input.result);
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
    return { changedFiles, commitSha, pullRequestUrl: data.html_url, skipped: false };
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
  return { changedFiles, commitSha, pullRequestUrl: data.html_url, skipped: false };
};
