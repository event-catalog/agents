import type { ReviewConfig } from '@/src/config';
import {
  azureFileUrl,
  azurePullRequestUrl,
  azureSourceRepository,
  azureTreeUrl,
  createAzureDevOpsCatalog,
  createAzureDevOpsSource,
  parseAzureRepository,
} from '@/src/providers/azure-devops';
import { resolveAzurePipelinesContext } from '@/src/providers/azure-pipelines';
import {
  bitbucketFileUrl,
  bitbucketPullRequestUrl,
  bitbucketSourceRepository,
  bitbucketTreeUrl,
  createBitbucketCatalog,
  createBitbucketSource,
  parseBitbucketRepository,
} from '@/src/providers/bitbucket';
import { resolveBitbucketPipelinesContext } from '@/src/providers/bitbucket-pipelines';
import {
  createGithubCatalog,
  createGithubSource,
  githubFileUrl,
  githubPullRequestUrl,
  githubTreeUrl,
} from '@/src/providers/github';
import type { CatalogRepositoryProvider, SourcePullRequestProvider } from '@/src/providers/types';

export type * from '@/src/providers/types';

type SourceContext = Partial<Pick<ReviewConfig, 'github' | 'azureDevOps' | 'bitbucket'>>;
type CatalogContext = Pick<ReviewConfig, 'catalogRepo' | 'catalogRef'> &
  Partial<Pick<ReviewConfig, 'catalogProvider' | 'azureDevOpsOrganization' | 'bitbucketWorkspace'>>;

/** The source pull request, as the shared code needs to refer to it. */
export interface SourcePullRequestInfo {
  number: number;
  /**
   * `acme/shop#12` on GitHub and Bitbucket, `Project/Repo!12` on Azure DevOps (`!` is how Azure DevOps
   * refers to pull requests).
   */
  reference: string;
  /** Names the agent's catalog branch for this pull request: `acme-shop`. */
  repositorySlug: string;
  url: string;
}

/** The source pull request, or undefined when the run has none (a local run, or a direct push). */
export const getSourcePullRequestInfo = (config: SourceContext): SourcePullRequestInfo | undefined => {
  if (config.github) {
    const { owner, repo, prNumber } = config.github;
    return {
      number: prNumber,
      reference: `${owner}/${repo}#${prNumber}`,
      repositorySlug: `${owner}-${repo}`,
      url: githubPullRequestUrl(config.github),
    };
  }

  if (config.azureDevOps?.prNumber !== undefined) {
    const { project, repository, prNumber } = config.azureDevOps;
    return {
      number: prNumber,
      reference: `${project}/${repository}!${prNumber}`,
      repositorySlug: `${project}-${repository}`,
      url: azurePullRequestUrl(azureSourceRepository(config.azureDevOps), prNumber),
    };
  }

  if (config.bitbucket?.prNumber !== undefined) {
    const { workspace, repository, prNumber } = config.bitbucket;
    return {
      number: prNumber,
      reference: `${workspace}/${repository}#${prNumber}`,
      repositorySlug: `${workspace}-${repository}`,
      url: bitbucketPullRequestUrl(bitbucketSourceRepository(config.bitbucket), prNumber),
    };
  }

  return undefined;
};

/** A link to `line` of `path` at `sha` in the source repository. */
export const getSourceFileUrl = (config: SourceContext, sha: string, path: string, line: number): string | undefined => {
  if (config.github) return githubFileUrl(config.github, sha, path, line);
  if (config.azureDevOps) return azureFileUrl(azureSourceRepository(config.azureDevOps), sha, path, line);
  if (config.bitbucket) return bitbucketFileUrl(bitbucketSourceRepository(config.bitbucket), sha, path, line);
  return undefined;
};

const azureCatalogRepository = (config: CatalogContext) =>
  parseAzureRepository(config.catalogRepo, config.azureDevOpsOrganization);

const bitbucketCatalogRepository = (config: CatalogContext) =>
  parseBitbucketRepository(config.catalogRepo, config.bitbucketWorkspace);

/** The catalog repository's name for people: `acme/catalog`, or `Project/Repo` on Azure DevOps. */
export const getCatalogDisplayName = (config: CatalogContext): string | undefined => {
  if (config.catalogProvider === 'azure-devops') {
    const repository = azureCatalogRepository(config);
    return repository ? `${repository.project}/${repository.repository}` : config.catalogRepo;
  }
  if (config.catalogProvider === 'bitbucket') {
    const repository = bitbucketCatalogRepository(config);
    return repository ? `${repository.workspace}/${repository.repository}` : config.catalogRepo;
  }
  return config.catalogRepo;
};

/** A link to the catalog repository at `catalog-ref`, or to `path` in it. */
export const getCatalogTreeUrl = (config: CatalogContext, path?: string): string | undefined => {
  if (!config.catalogRepo) return undefined;
  if (config.catalogProvider === 'azure-devops') {
    const repository = azureCatalogRepository(config);
    return repository ? azureTreeUrl(repository, config.catalogRef, path) : undefined;
  }
  if (config.catalogProvider === 'bitbucket') {
    const repository = bitbucketCatalogRepository(config);
    return repository ? bitbucketTreeUrl(repository, config.catalogRef, path) : undefined;
  }
  return githubTreeUrl(config.catalogRepo, config.catalogRef, path);
};

/**
 * Where to comment and read the description, or undefined when there is no pull request to talk to:
 * the run then logs instead of commenting.
 */
export const getSourceProvider = (config: ReviewConfig): SourcePullRequestProvider | undefined => {
  if (config.github) return createGithubSource(config.github);
  if (config.azureDevOps?.prNumber !== undefined) {
    return createAzureDevOpsSource({ ...config.azureDevOps, prNumber: config.azureDevOps.prNumber });
  }
  if (config.bitbucket?.prNumber !== undefined) {
    return createBitbucketSource({ ...config.bitbucket, prNumber: config.bitbucket.prNumber });
  }
  return undefined;
};

/** The catalog repository's provider. Throws when the repository or token is missing or malformed. */
export const getCatalogProvider = (config: ReviewConfig): CatalogRepositoryProvider => {
  if (config.catalogProvider === 'azure-devops') return createAzureDevOpsCatalog(config);
  if (config.catalogProvider === 'bitbucket') return createBitbucketCatalog(config);
  return createGithubCatalog(config);
};

type CiContext = Partial<Pick<ReviewConfig, 'azureDevOpsOrganization' | 'bitbucketWorkspace'>>;

/** The token settings in Bitbucket: secured variables, so they never appear in the pipeline file. */
const BITBUCKET_TOKEN_VARIABLES: Record<string, string> = { 'catalog-token': 'EVENTCATALOG_CATALOG_TOKEN' };

/**
 * A setting as the user wrote it: the GitHub Action's inputs are kebab-case (`catalog-repo`), the Azure
 * Pipelines template's parameters camelCase (`catalogRepo`), and the Bitbucket Pipelines script's
 * options flags (`--catalog-repo`), except tokens, which are secured variables.
 */
export const settingName = (config: CiContext, name: string): string => {
  if (config.azureDevOpsOrganization) return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  if (config.bitbucketWorkspace) return BITBUCKET_TOKEN_VARIABLES[name] ?? `--${name}`;
  return name;
};

/** `describeSettings(config, ['catalog-repo', 'catalog-ref'])` → "`catalog-repo` and `catalog-ref` inputs". */
export const describeSettings = (config: CiContext, names: string[]): string => {
  const formatted = names.map((name) => `\`${settingName(config, name)}\``);
  const list = formatted.length > 1 ? `${formatted.slice(0, -1).join(', ')} and ${formatted.at(-1)}` : formatted[0];
  const noun = config.azureDevOpsOrganization ? 'parameter' : config.bitbucketWorkspace ? 'option' : 'input';
  return `${list} ${noun}${names.length > 1 ? 's' : ''}`;
};

/** What to grant when the catalog token can't reach the catalog repository. */
export const catalogAccessNextStep = (config: ReviewConfig): string => {
  const catalog = getCatalogDisplayName(config) ?? 'the catalog repository';
  const token = `\`${settingName(config, 'catalog-token')}\``;
  if (config.catalogProvider === 'azure-devops') {
    return `Give the pipeline's build service (or the ${token}) the Contribute, Create branch, and Contribute to pull requests permissions on ${catalog}.`;
  }
  if (config.catalogProvider === 'bitbucket') {
    const variable = config.bitbucketWorkspace ? token : `\`${settingName(config, 'catalog-token')}\``;
    return `Give the access token in ${variable} (or EVENTCATALOG_BITBUCKET_TOKEN, when that is unset) the Repositories: Write and Pull requests: Write permissions on ${catalog}.`;
  }
  const app = config.azureDevOpsOrganization || config.bitbucketWorkspace ? '' : ' (or the GitHub App)';
  return `Give the ${token}${app} read and write access to ${catalog}, with permission to open pull requests.`;
};

/**
 * Completes what `resolveConfig` reads from the environment with what needs git or an API call. On
 * GitHub nothing is missing. In Azure Pipelines and Bitbucket Pipelines it finds the commits to diff, and
 * after a merge, the pull request that merged; a build with none (e.g. a direct push) gets a `skipReason`.
 */
export const resolvePullRequestContext = (config: ReviewConfig): Promise<ReviewConfig> => {
  if (config.azureDevOps) return resolveAzurePipelinesContext(config);
  if (config.bitbucket) return resolveBitbucketPipelinesContext(config);
  return Promise.resolve(config);
};
