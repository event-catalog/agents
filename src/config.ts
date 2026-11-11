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
  /** The pull request description. When unset, ADR Compliance reads it from GitHub, Azure DevOps or Bitbucket. */
  pullRequestBody?: string;
  /** `open`, `merged`, or `closed` (closed without merging). Defaults to `open`. */
  pullRequestState?: PullRequestState;
  schemaExtensions?: string[] | string;
  workspace?: string;
}

/** A hosted Git service the agents can read pull requests from and open them in. */
export type SourceControlProvider = 'github' | 'azure-devops' | 'bitbucket';

export const SOURCE_CONTROL_PROVIDERS: SourceControlProvider[] = ['github', 'azure-devops', 'bitbucket'];

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

/**
 * A pull request in Bitbucket Cloud, read from the Bitbucket Pipelines default variables. A pull request
 * pipeline knows its pull request; a branch pipeline after a merge finds it from the merge commit, so
 * `prNumber` is unset until `resolvePullRequestContext` looks it up.
 */
export interface BitbucketReviewTarget {
  /** The branch a branch pipeline built: the target branch the pull request merged into. */
  branch?: string;
  /** The commit the pipeline built (`BITBUCKET_COMMIT`): the pull request's source commit, or the merge commit. */
  commit?: string;
  /** The pull request's target branch tip when the pipeline started, on a pull request pipeline. */
  destinationCommit?: string;
  prNumber?: number;
  /** The repository slug. */
  repository: string;
  /** An access token that can comment on the repository's pull requests. Checked before use. */
  token?: string;
  /** The Bitbucket workspace's slug. */
  workspace: string;
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
  /** The source pull request when it is in Bitbucket Cloud (Bitbucket Pipelines). */
  bitbucket?: BitbucketReviewTarget;
  /**
   * The Bitbucket workspace of the pipeline running the agent: where a short catalog repository name
   * (`repo`) is looked up. Set in any Bitbucket Pipelines run.
   */
  bitbucketWorkspace?: string;
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

/** True when running in Bitbucket Pipelines, which numbers every build. */
export const isBitbucketPipelines = (env: NodeJS.ProcessEnv): boolean => Boolean(env.BITBUCKET_BUILD_NUMBER);

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
const parsePullRequestState = (
  payload: ReviewPayload,
  env: NodeJS.ProcessEnv,
  ci: { azureDevOps: boolean; bitbucket: boolean }
): PullRequestState => {
  if (payload.pullRequestState) return payload.pullRequestState;
  if (ci.azureDevOps) return env.BUILD_REASON === 'PullRequest' ? 'open' : 'merged';
  // Bitbucket has no pull request merged trigger: a pull request pipeline is open, and a branch pipeline
  // of the target branch runs after the merge.
  if (ci.bitbucket) return env.BITBUCKET_PR_ID ? 'open' : 'merged';
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

/** The Bitbucket Cloud pull request this pipeline is for, from the Bitbucket Pipelines default variables. */
const parseBitbucketTarget = (payload: ReviewPayload, env: NodeJS.ProcessEnv): BitbucketReviewTarget | undefined => {
  if (!isBitbucketPipelines(env)) return undefined;
  const [fullWorkspace, fullRepository] = (env.BITBUCKET_REPO_FULL_NAME ?? '').split('/');
  const workspace = env.BITBUCKET_WORKSPACE?.trim() || fullWorkspace;
  const repository = env.BITBUCKET_REPO_SLUG?.trim() || fullRepository;
  if (!workspace || !repository) return undefined;

  return {
    branch: env.BITBUCKET_BRANCH || undefined,
    commit: env.BITBUCKET_COMMIT || undefined,
    destinationCommit: env.BITBUCKET_PR_DESTINATION_COMMIT || undefined,
    prNumber: parseOptionalInteger(payload.prNumber ?? env.BITBUCKET_PR_ID),
    repository,
    token: env.EVENTCATALOG_BITBUCKET_TOKEN || undefined,
    workspace,
  };
};

/**
 * Where the catalog is hosted: set explicitly, or a repository URL that names its host (Azure Repos'
 * `…/_git/…`, `bitbucket.org`), or otherwise the CI system the agent runs in (Azure Pipelines → Azure
 * Repos, Bitbucket Pipelines → Bitbucket, anything else → GitHub).
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
  if (/^(https?:\/\/)?([^@/]+@)?bitbucket\.org\//i.test(catalogRepo.trim())) return 'bitbucket';
  if (isAzurePipelines(env)) return 'azure-devops';
  return isBitbucketPipelines(env) ? 'bitbucket' : 'github';
};

export const resolveConfig = (payload: ReviewPayload | undefined, env: NodeJS.ProcessEnv): ReviewConfig => {
  const p = payload ?? {};
  const ignorePaths = parseCommaList(p.ignorePaths ?? env.EVENTCATALOG_IGNORE_PATHS);
  const schemaExtensions = parseCommaList(p.schemaExtensions ?? env.EVENTCATALOG_SCHEMA_EXTENSIONS);
  const github = parseGithubTarget(p, env);
  const azureDevOpsOrganization = parseAzureDevOpsOrganization(env);
  // A GitHub pull request wins, so an explicit GitHub payload behaves the same everywhere.
  const azureDevOps = github ? undefined : parseAzureDevOpsTarget(p, env, azureDevOpsOrganization);
  const bitbucket = github || azureDevOps ? undefined : parseBitbucketTarget(p, env);
  const buildReason = env.BUILD_REASON ?? '';
  const skipReason =
    azureDevOps && !p.pullRequestState && buildReason !== 'PullRequest' && !AZURE_MERGE_BUILD_REASONS.includes(buildReason)
      ? `This Azure Pipelines build (reason: ${buildReason || 'unknown'}) is not for a pull request or a merge, so there is nothing to review.`
      : bitbucket && !p.pullRequestState && env.BITBUCKET_TAG
        ? `This Bitbucket pipeline built the tag ${env.BITBUCKET_TAG}, not a pull request or a merge, so there is nothing to review.`
        : undefined;
  const catalogProvider = parseCatalogProvider(p, env);

  return {
    adrs: parseCommaList(p.adrs ?? env.EVENTCATALOG_ADRS),
    azureDevOps,
    azureDevOpsOrganization,
    baseSha: p.baseSha || env.EVENTCATALOG_BASE_SHA,
    bitbucket,
    bitbucketWorkspace: isBitbucketPipelines(env) ? env.BITBUCKET_WORKSPACE?.trim() || undefined : undefined,
    catalogPath: p.catalogPath || env.EVENTCATALOG_CATALOG_PATH || 'eventcatalog',
    catalogProvider,
    catalogRef: p.catalogRef || env.EVENTCATALOG_CATALOG_REF || 'main',
    catalogRepo: p.catalogRepo || env.EVENTCATALOG_CATALOG_REPO,
    // In Bitbucket, one workspace or project access token can cover both repositories, so the source
    // token is the default for a Bitbucket catalog.
    catalogToken:
      p.catalogToken ||
      env.EVENTCATALOG_CATALOG_TOKEN ||
      (bitbucket && catalogProvider === 'bitbucket' ? bitbucket.token : undefined),
    catalogUrl: p.catalogUrl || env.EVENTCATALOG_CATALOG_URL,
    github,
    headSha: p.headSha || env.EVENTCATALOG_HEAD_SHA,
    ignorePaths: ignorePaths.length > 0 ? ignorePaths : DEFAULT_DIFF_IGNORE_PATHS,
    model: p.model || env.EVENTCATALOG_MODEL || env.MODEL || 'anthropic/claude-sonnet-4-6',
    pullRequestBody: p.pullRequestBody,
    pullRequestState: parsePullRequestState(p, env, { azureDevOps: Boolean(azureDevOps), bitbucket: Boolean(bitbucket) }),
    schemaExtensions: schemaExtensions.length > 0 ? schemaExtensions : DEFAULT_SCHEMA_EXTENSIONS,
    skipReason,
    thinkingLevel: env.THINKING_LEVEL || 'medium',
    workspace:
      p.workspace ||
      env.EVENTCATALOG_WORKSPACE ||
      env.GITHUB_WORKSPACE ||
      env.BUILD_SOURCESDIRECTORY ||
      env.BITBUCKET_CLONE_DIR ||
      env.WORKSPACE ||
      process.cwd(),
  };
};
