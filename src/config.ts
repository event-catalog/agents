import { DEFAULT_SCHEMA_EXTENSIONS } from '@/src/utils/schema-detection';

export interface ReviewPayload {
  baseSha?: string;
  catalogPath?: string;
  catalogRef?: string;
  catalogRepo?: string;
  catalogToken?: string;
  catalogUrl?: string;
  githubRepository?: string;
  githubToken?: string;
  headSha?: string;
  ignorePaths?: string[] | string;
  model?: string;
  prNumber?: number | string;
  /** `open`, `merged`, or `closed` (closed without merging). Defaults to `open`. */
  pullRequestState?: PullRequestState;
  schemaExtensions?: string[] | string;
  workspace?: string;
}

/**
 * Where the source pull request is: `open` (opened or updated), `merged`, or `closed` without merging.
 * Workflows can run the agents when a PR merges (`on: pull_request: types: [closed]`).
 */
export type PullRequestState = 'open' | 'merged' | 'closed';

/** The result message when a run is skipped because the pull request was closed without merging. */
export const CLOSED_WITHOUT_MERGE_MESSAGE = 'Pull request closed without merging; nothing to review.';

/** The analytics `trigger` for a run: a merged pull request, or an open one. */
export const runTrigger = (config: Pick<ReviewConfig, 'pullRequestState'>): 'pull_request' | 'merged' =>
  config.pullRequestState === 'merged' ? 'merged' : 'pull_request';

export interface GithubReviewTarget {
  owner: string;
  prNumber: number;
  repo: string;
  token: string;
}

export interface ReviewConfig {
  baseSha?: string;
  catalogPath: string;
  catalogRef: string;
  catalogRepo?: string;
  catalogToken?: string;
  /** Hosted EventCatalog base URL, used to link catalog resources in PR comments. */
  catalogUrl?: string;
  github?: GithubReviewTarget;
  headSha?: string;
  ignorePaths: string[];
  model: string;
  pullRequestState: PullRequestState;
  /** Extensions (e.g. `.json`, `.js`) treated as message schemas by the breaking-changes agent. */
  schemaExtensions: string[];
  thinkingLevel: string;
  workspace: string;
}

export const DEFAULT_DIFF_IGNORE_PATHS = [
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.astro',
  '.turbo',
  '.cache',
  '.vite',
  '.vercel',
  '.netlify',
  'out',
  'target',
  'bin',
  'obj',
  'vendor',
];

/** Parse a comma-separated string (or pass through an array), trimming and dropping empties. */
const parseCommaList = (value: string[] | string | undefined): string[] => {
  if (Array.isArray(value)) {
    return value.map((entry) => entry.trim()).filter(Boolean);
  }

  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
};

/** From the GitHub event: a `closed` action is `merged` or `closed` depending on `pull_request.merged`. */
const parsePullRequestState = (payload: ReviewPayload, env: NodeJS.ProcessEnv): PullRequestState => {
  if (payload.pullRequestState) return payload.pullRequestState;
  if (env.EVENTCATALOG_EVENT_ACTION !== 'closed') return 'open';
  return env.EVENTCATALOG_PR_MERGED === 'true' ? 'merged' : 'closed';
};

const parseGithubTarget = (payload: ReviewPayload, env: NodeJS.ProcessEnv): GithubReviewTarget | undefined => {
  const repository = payload.githubRepository || env.EVENTCATALOG_GITHUB_REPOSITORY || env.GITHUB_REPOSITORY;
  const token = payload.githubToken || env.EVENTCATALOG_GITHUB_TOKEN || env.GITHUB_TOKEN;
  const rawPrNumber = payload.prNumber || env.EVENTCATALOG_PR_NUMBER || env.GITHUB_PR_NUMBER;
  const prNumber = typeof rawPrNumber === 'number' ? rawPrNumber : Number.parseInt(rawPrNumber ?? '', 10);
  const [owner, repo] = (repository ?? '').split('/');

  if (!owner || !repo || !token || !Number.isInteger(prNumber)) {
    return undefined;
  }

  return { owner, prNumber, repo, token };
};

export const resolveConfig = (payload: ReviewPayload | undefined, env: NodeJS.ProcessEnv): ReviewConfig => {
  const p = payload ?? {};
  const ignorePaths = parseCommaList(p.ignorePaths ?? env.EVENTCATALOG_IGNORE_PATHS);
  const schemaExtensions = parseCommaList(p.schemaExtensions ?? env.EVENTCATALOG_SCHEMA_EXTENSIONS);

  return {
    baseSha: p.baseSha || env.EVENTCATALOG_BASE_SHA,
    catalogPath: p.catalogPath || env.EVENTCATALOG_CATALOG_PATH || 'eventcatalog',
    catalogRef: p.catalogRef || env.EVENTCATALOG_CATALOG_REF || 'main',
    catalogRepo: p.catalogRepo || env.EVENTCATALOG_CATALOG_REPO,
    catalogToken: p.catalogToken || env.EVENTCATALOG_CATALOG_TOKEN,
    catalogUrl: p.catalogUrl || env.EVENTCATALOG_CATALOG_URL,
    github: parseGithubTarget(p, env),
    headSha: p.headSha || env.EVENTCATALOG_HEAD_SHA,
    ignorePaths: ignorePaths.length > 0 ? ignorePaths : DEFAULT_DIFF_IGNORE_PATHS,
    model: p.model || env.EVENTCATALOG_MODEL || env.MODEL || 'anthropic/claude-sonnet-4-6',
    pullRequestState: parsePullRequestState(p, env),
    schemaExtensions: schemaExtensions.length > 0 ? schemaExtensions : DEFAULT_SCHEMA_EXTENSIONS,
    thinkingLevel: env.THINKING_LEVEL || 'medium',
    workspace: p.workspace || env.GITHUB_WORKSPACE || env.WORKSPACE || process.cwd(),
  };
};
