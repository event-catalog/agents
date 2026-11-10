import { DEFAULT_SCHEMA_EXTENSIONS } from '@/src/utils/schema-detection';

export interface ReviewPayload {
  /** ADR Compliance: which ADRs to check against, as globs relative to the catalog root. */
  adrs?: string[] | string;
  baseSha?: string;
  catalogPath?: string;
  /** Where the catalog repository is hosted. Inferred from `catalogRepo` and the CI system when unset. */
  catalogProvider?: SourceControlProvider;
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
  /** The pull request description. When unset, ADR Compliance reads it from GitHub or Azure DevOps. */
  pullRequestBody?: string;
  /** `open`, `merged`, or `closed` (closed without merging). Defaults to `open`. */
  pullRequestState?: PullRequestState;
  schemaExtensions?: string[] | string;
  workspace?: string;
}

/** A hosted Git service the agents can read pull requests from and open them in. */
export type SourceControlProvider = 'github' | 'azure-devops';

export const SOURCE_CONTROL_PROVIDERS: SourceControlProvider[] = ['github', 'azure-devops'];

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

/** The Azure DevOps organization and project a pipeline runs in. */
export interface AzureDevOpsOrganization {
  /** The organization (or collection) URL, always ending in `/`: `https://dev.azure.com/acme/`. */
  collectionUri: string;
  project: string;
}

/**
 * A pull request in Azure Repos, read from the Azure Pipelines predefined variables. On a build after a
 * merge (a CI build on the target branch) the pull request is found from the merge commit, so `prNumber`
 * is unset until `resolvePullRequestContext` looks it up.
 */
export interface AzureDevOpsReviewTarget extends AzureDevOpsOrganization {
  /** The commit the build checked out: the PR merge commit, or the target branch commit after a merge. */
  commitId?: string;
  prNumber?: number;
  /** The repository name. */
  repository: string;
  repositoryId: string;
  token: string;
}

export interface ReviewConfig {
  /** Globs relative to the catalog root selecting the ADRs that ADR Compliance checks against. */
  adrs: string[];
  baseSha?: string;
  /** The source pull request when it is in Azure Repos (Azure Pipelines). Unset on GitHub. */
  azureDevOps?: AzureDevOpsReviewTarget;
  /**
   * The organization and project of the Azure pipeline running the agent: where a short catalog
   * repository name (`Project/Repo`) is looked up. Set in any Azure Pipelines run, with or without a
   * source pull request.
   */
  azureDevOpsOrganization?: AzureDevOpsOrganization;
  catalogPath: string;
  /** Where the catalog repository is hosted, and so where Code-to-Docs opens its pull requests. */
  catalogProvider: SourceControlProvider;
  catalogRef: string;
  catalogRepo?: string;
  catalogToken?: string;
  /** Hosted EventCatalog base URL, used to link catalog resources in PR comments. */
  catalogUrl?: string;
  github?: GithubReviewTarget;
  headSha?: string;
  ignorePaths: string[];
  model: string;
  pullRequestBody?: string;
  pullRequestState: PullRequestState;
  /**
   * Why this run has no pull request to review, e.g. an Azure Pipelines build that no pull request
   * triggered. The workflows skip it quietly, like a pull request closed without merging.
   */
  skipReason?: string;
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

/** True when running in Azure Pipelines, which sets `TF_BUILD` on every build. */
export const isAzurePipelines = (env: NodeJS.ProcessEnv): boolean => env.TF_BUILD?.toLowerCase() === 'true';

/**
 * Azure Pipelines build reasons (`Build.Reason`) that run after a merge: the CI trigger, or a run queued
 * by hand (e.g. to retry). Scheduled and other builds are not about a pull request, so they are skipped
 * rather than reviewing the last merged one again.
 */
const AZURE_MERGE_BUILD_REASONS = ['IndividualCI', 'BatchedCI', 'Manual'];

/**
 * From the GitHub event: a `closed` action is `merged` or `closed` depending on `pull_request.merged`.
 * In Azure Pipelines a pull request build (build validation) is `open`, and a CI or manual build of the
 * target branch runs after a merge.
 */
const parsePullRequestState = (payload: ReviewPayload, env: NodeJS.ProcessEnv, azureDevOps: boolean): PullRequestState => {
  if (payload.pullRequestState) return payload.pullRequestState;
  if (azureDevOps) return env.BUILD_REASON === 'PullRequest' ? 'open' : 'merged';
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

const parseOptionalInteger = (value: number | string | undefined): number | undefined => {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) ? parsed : undefined;
};

/** The organization and project of the running Azure pipeline. */
const parseAzureDevOpsOrganization = (env: NodeJS.ProcessEnv): AzureDevOpsOrganization | undefined => {
  const collectionUri = env.SYSTEM_COLLECTIONURI?.trim();
  const project = env.SYSTEM_TEAMPROJECT?.trim();
  if (!isAzurePipelines(env) || !collectionUri || !project) return undefined;
  return { collectionUri: collectionUri.endsWith('/') ? collectionUri : `${collectionUri}/`, project };
};

/** The Azure Repos pull request this build is for, from the Azure Pipelines predefined variables. */
const parseAzureDevOpsTarget = (
  payload: ReviewPayload,
  env: NodeJS.ProcessEnv,
  organization: AzureDevOpsOrganization | undefined
): AzureDevOpsReviewTarget | undefined => {
  // Azure Pipelines can also build GitHub repositories; those use the GitHub Action instead.
  if (!organization || env.BUILD_REPOSITORY_PROVIDER !== 'TfsGit') return undefined;

  const repository = env.BUILD_REPOSITORY_NAME?.trim();
  const repositoryId = env.BUILD_REPOSITORY_ID?.trim() || repository;
  const token = env.EVENTCATALOG_AZURE_DEVOPS_TOKEN || env.SYSTEM_ACCESSTOKEN;

  if (!repository || !repositoryId || !token) return undefined;

  return {
    ...organization,
    commitId: env.BUILD_SOURCEVERSION || undefined,
    prNumber: parseOptionalInteger(payload.prNumber ?? env.SYSTEM_PULLREQUEST_PULLREQUESTID),
    repository,
    repositoryId,
    token,
  };
};

/**
 * Where the catalog is hosted: set explicitly, or an Azure Repos URL (`…/_git/…`), or otherwise the CI
 * system the agent runs in (Azure Pipelines → Azure Repos, anything else → GitHub).
 */
const parseCatalogProvider = (payload: ReviewPayload, env: NodeJS.ProcessEnv): SourceControlProvider => {
  const explicit = (payload.catalogProvider || env.EVENTCATALOG_CATALOG_PROVIDER)?.trim();
  if (explicit) {
    if (!SOURCE_CONTROL_PROVIDERS.includes(explicit as SourceControlProvider)) {
      throw new Error(`Unknown catalog provider '${explicit}'. Available: ${SOURCE_CONTROL_PROVIDERS.join(', ')}.`);
    }
    return explicit as SourceControlProvider;
  }

  const catalogRepo = payload.catalogRepo || env.EVENTCATALOG_CATALOG_REPO || '';
  if (catalogRepo.includes('/_git/')) return 'azure-devops';
  return isAzurePipelines(env) ? 'azure-devops' : 'github';
};

export const resolveConfig = (payload: ReviewPayload | undefined, env: NodeJS.ProcessEnv): ReviewConfig => {
  const p = payload ?? {};
  const ignorePaths = parseCommaList(p.ignorePaths ?? env.EVENTCATALOG_IGNORE_PATHS);
  const schemaExtensions = parseCommaList(p.schemaExtensions ?? env.EVENTCATALOG_SCHEMA_EXTENSIONS);
  const github = parseGithubTarget(p, env);
  const azureDevOpsOrganization = parseAzureDevOpsOrganization(env);
  // A GitHub pull request wins, so an explicit GitHub payload behaves the same everywhere.
  const azureDevOps = github ? undefined : parseAzureDevOpsTarget(p, env, azureDevOpsOrganization);
  const buildReason = env.BUILD_REASON ?? '';
  const skipReason =
    azureDevOps && !p.pullRequestState && buildReason !== 'PullRequest' && !AZURE_MERGE_BUILD_REASONS.includes(buildReason)
      ? `This Azure Pipelines build (reason: ${buildReason || 'unknown'}) is not for a pull request or a merge, so there is nothing to review.`
      : undefined;

  return {
    adrs: parseCommaList(p.adrs ?? env.EVENTCATALOG_ADRS),
    azureDevOps,
    azureDevOpsOrganization,
    baseSha: p.baseSha || env.EVENTCATALOG_BASE_SHA,
    catalogPath: p.catalogPath || env.EVENTCATALOG_CATALOG_PATH || 'eventcatalog',
    catalogProvider: parseCatalogProvider(p, env),
    catalogRef: p.catalogRef || env.EVENTCATALOG_CATALOG_REF || 'main',
    catalogRepo: p.catalogRepo || env.EVENTCATALOG_CATALOG_REPO,
    catalogToken: p.catalogToken || env.EVENTCATALOG_CATALOG_TOKEN,
    catalogUrl: p.catalogUrl || env.EVENTCATALOG_CATALOG_URL,
    github,
    headSha: p.headSha || env.EVENTCATALOG_HEAD_SHA,
    ignorePaths: ignorePaths.length > 0 ? ignorePaths : DEFAULT_DIFF_IGNORE_PATHS,
    model: p.model || env.EVENTCATALOG_MODEL || env.MODEL || 'anthropic/claude-sonnet-4-6',
    pullRequestBody: p.pullRequestBody,
    pullRequestState: parsePullRequestState(p, env, Boolean(azureDevOps)),
    schemaExtensions: schemaExtensions.length > 0 ? schemaExtensions : DEFAULT_SCHEMA_EXTENSIONS,
    skipReason,
    thinkingLevel: env.THINKING_LEVEL || 'medium',
    workspace:
      p.workspace ||
      env.EVENTCATALOG_WORKSPACE ||
      env.GITHUB_WORKSPACE ||
      env.BUILD_SOURCESDIRECTORY ||
      env.WORKSPACE ||
      process.cwd(),
  };
};
