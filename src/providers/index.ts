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
  createGithubCatalog,
  createGithubSource,
  githubFileUrl,
  githubPullRequestUrl,
  githubTreeUrl,
} from '@/src/providers/github';
import type { CatalogRepositoryProvider, SourcePullRequestProvider } from '@/src/providers/types';

export type * from '@/src/providers/types';

type SourceContext = Partial<Pick<ReviewConfig, 'github' | 'azureDevOps'>>;
type CatalogContext = Pick<ReviewConfig, 'catalogRepo' | 'catalogRef'> &
  Partial<Pick<ReviewConfig, 'catalogProvider' | 'azureDevOpsOrganization'>>;

/** The source pull request, as the shared code needs to refer to it. */
export interface SourcePullRequestInfo {
  number: number;
  /** `acme/shop#12` on GitHub, `Project/Repo!12` on Azure DevOps (`!` is how Azure DevOps refers to pull requests). */
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

  return undefined;
};

/** A link to `line` of `path` at `sha` in the source repository. */
export const getSourceFileUrl = (config: SourceContext, sha: string, path: string, line: number): string | undefined => {
  if (config.github) return githubFileUrl(config.github, sha, path, line);
  if (config.azureDevOps) return azureFileUrl(azureSourceRepository(config.azureDevOps), sha, path, line);
  return undefined;
};

const azureCatalogRepository = (config: CatalogContext) =>
  parseAzureRepository(config.catalogRepo, config.azureDevOpsOrganization);

/** The catalog repository's name for people: `acme/catalog`, or `Project/Repo` on Azure DevOps. */
export const getCatalogDisplayName = (config: CatalogContext): string | undefined => {
  if (config.catalogProvider === 'azure-devops') {
    const repository = azureCatalogRepository(config);
    return repository ? `${repository.project}/${repository.repository}` : config.catalogRepo;
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
  return undefined;
};

/** The catalog repository's provider. Throws when the repository or token is missing or malformed. */
export const getCatalogProvider = (config: ReviewConfig): CatalogRepositoryProvider =>
  config.catalogProvider === 'azure-devops' ? createAzureDevOpsCatalog(config) : createGithubCatalog(config);

type CiContext = Partial<Pick<ReviewConfig, 'azureDevOpsOrganization'>>;

/**
 * A setting as the user wrote it: the GitHub Action's inputs are kebab-case (`catalog-repo`), the Azure
 * Pipelines template's parameters camelCase (`catalogRepo`).
 */
export const settingName = (config: CiContext, name: string): string =>
  config.azureDevOpsOrganization ? name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()) : name;

/** `describeSettings(config, ['catalog-repo', 'catalog-ref'])` → "`catalog-repo` and `catalog-ref` inputs". */
export const describeSettings = (config: CiContext, names: string[]): string => {
  const formatted = names.map((name) => `\`${settingName(config, name)}\``);
  const list = formatted.length > 1 ? `${formatted.slice(0, -1).join(', ')} and ${formatted.at(-1)}` : formatted[0];
  const noun = config.azureDevOpsOrganization ? 'parameter' : 'input';
  return `${list} ${noun}${names.length > 1 ? 's' : ''}`;
};

/** What to grant when the catalog token can't reach the catalog repository. */
export const catalogAccessNextStep = (config: ReviewConfig): string => {
  const catalog = getCatalogDisplayName(config) ?? 'the catalog repository';
  const token = `\`${settingName(config, 'catalog-token')}\``;
  if (config.catalogProvider === 'azure-devops') {
    return `Give the pipeline's build service (or the ${token}) the Contribute, Create branch, and Contribute to pull requests permissions on ${catalog}.`;
  }
  const app = config.azureDevOpsOrganization ? '' : ' (or the GitHub App)';
  return `Give the ${token}${app} read and write access to ${catalog}, with permission to open pull requests.`;
};

/**
 * Completes what `resolveConfig` reads from the environment with what needs git or an API call. On
 * GitHub nothing is missing. In Azure Pipelines it finds the commits to diff, and after a merge, the pull
 * request that merged; a build with none (e.g. a direct push) gets a `skipReason`.
 */
export const resolvePullRequestContext = (config: ReviewConfig): Promise<ReviewConfig> =>
  config.azureDevOps ? resolveAzurePipelinesContext(config) : Promise.resolve(config);
