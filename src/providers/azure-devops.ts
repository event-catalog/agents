import type { AzureDevOpsOrganization, AzureDevOpsReviewTarget, ReviewConfig } from '@/src/config';
import { gitConfigEnv } from '@/src/utils/git';
import { sendWithRetry } from '@/src/providers/http';
import { fitLength, fitMarkdown, replaceCommentMarker, withoutGithubExtensions } from '@/src/providers/markdown';
import type {
  AgentPullRequestStats,
  CatalogPreflightResult,
  CatalogPullRequestInput,
  CatalogRepositoryProvider,
  CommentTone,
  SourcePullRequestProvider,
  UpsertCommentOptions,
} from '@/src/providers/types';

/**
 * Azure DevOps (Azure Repos): pull request threads and catalog pull requests, through the REST API.
 * Works with Azure DevOps Services and Azure DevOps Server; it uses API version 6.0, which both support.
 * Authenticates with the pipeline's `System.AccessToken` or a personal access token.
 */

const API_VERSION = '6.0';

/** Azure DevOps limits a pull request description to 4000 characters. */
const MAX_DESCRIPTION_LENGTH = 4000;
const MAX_TITLE_LENGTH = 400;

/** The thread property that marks the agent's comment, so reruns find and update it. */
const MARKER_PROPERTY = 'EventCatalogAgents.CommentMarker';

/**
 * Where an Azure Repos repository is. `collectionUri` always ends in `/`: it is normalised where it is
 * read (the pipeline variables, or `parseAzureRepository`), and trusted from then on.
 */
export interface AzureRepository extends AzureDevOpsOrganization {
  repository: string;
}

/** Splits a repository URL's path at `_git`: the segments before it and the repository after it. */
const parseGitPath = (url: URL) => {
  const match = url.pathname.match(/^\/((?:[^/]+\/)*)_git\/([^/]+)$/);
  if (!match) return undefined;
  return { segments: match[1].split('/').filter(Boolean).map(decodeURIComponent), repository: decodeURIComponent(match[2]) };
};

/**
 * Reads an Azure Repos repository from the `catalog-repo` setting. Accepts a full URL
 * (`https://dev.azure.com/acme/Architecture/_git/catalog`, the `visualstudio.com` and Azure DevOps
 * Server forms too), `Project/Repo`, or just `Repo`. The short forms use the organization and project
 * of the pipeline that's running.
 */
export const parseAzureRepository = (
  value: string | undefined,
  defaults: Partial<AzureDevOpsOrganization> = {}
): AzureRepository | undefined => {
  const trimmed = value
    ?.trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  if (!trimmed) return undefined;

  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return undefined;
    }
    // Only the origin and path are read, so the user name in a clone URL copied from Azure DevOps
    // (`https://acme@dev.azure.com/…`) is dropped.
    const path = parseGitPath(url);
    if (!path) return undefined;
    const { segments, repository } = path;

    // Azure DevOps Services knows where the organization ends. A repository named after its project
    // has a URL without the project (`dev.azure.com/acme/_git/Orders`).
    const host = url.hostname.toLowerCase();
    // Older `visualstudio.com` URLs can include the `DefaultCollection` segment.
    const organizationSegments =
      host === 'dev.azure.com'
        ? 1
        : host.endsWith('.visualstudio.com')
          ? Number(segments[0]?.toLowerCase() === 'defaultcollection')
          : undefined;
    if (organizationSegments !== undefined) {
      const projectSegments = segments.slice(organizationSegments);
      if (segments.length < organizationSegments || projectSegments.length > 1) return undefined;
      const organization = segments.slice(0, organizationSegments).map(encodeURIComponent);
      return {
        collectionUri: `${url.origin}/${organization.map((segment) => `${segment}/`).join('')}`,
        project: projectSegments[0] ?? repository,
        repository,
      };
    }

    // Azure DevOps Server (`https://server/tfs/Collection/Project/_git/Repo`): the project is the last
    // segment before `_git`; everything before it is the collection. A Server URL must include the
    // project: without it (`…/Collection/_git/Repo`) the collection would be read as the project, and the
    // two forms can't be told apart.
    if (segments.length < 2) return undefined;
    const collection = segments.slice(0, -1).map(encodeURIComponent);
    return { collectionUri: `${url.origin}/${collection.join('/')}/`, project: segments.at(-1) as string, repository };
  }

  const parts = trimmed.split('/');
  const collectionUri = defaults.collectionUri;
  if (!collectionUri) return undefined;

  if (parts.length === 1 && defaults.project) return { collectionUri, project: defaults.project, repository: parts[0] };
  if (parts.length === 2 && parts[0] && parts[1]) return { collectionUri, project: parts[0], repository: parts[1] };
  return undefined;
};

/**
 * `System.AccessToken` is a JWT and is sent as a bearer token; a personal access token is sent with
 * basic auth and an empty user name, as Azure DevOps documents for each.
 */
export const azureAuthorization = (token: string): string =>
  /^eyJ[\w-]*\.[\w-]+\.[\w-]*$/.test(token) ? `Bearer ${token}` : `Basic ${Buffer.from(`:${token}`).toString('base64')}`;

const repositoryUrl = ({ collectionUri, project, repository }: AzureRepository): string =>
  `${collectionUri}${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}`;

const apiUrl = ({ collectionUri, project, repository }: AzureRepository, path: string, query: Record<string, string> = {}) => {
  const search = new URLSearchParams({ ...query, 'api-version': API_VERSION });
  const base = `${collectionUri}${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repository)}`;
  return `${base}${path}?${search.toString()}`;
};

const request = async <T>(
  token: string,
  method: string,
  url: string,
  body?: unknown,
  { safeToRepeat = method !== 'POST' }: { safeToRepeat?: boolean } = {}
): Promise<T> => {
  const send = () =>
    fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: azureAuthorization(token),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const response = await sendWithRetry(send, safeToRepeat);

  const text = await response.text();
  const isJson = (response.headers.get('content-type') ?? '').includes('json');
  const path = new URL(url).pathname;

  // A token Azure DevOps doesn't accept can get a 203 with a sign-in page instead of a 401. An empty
  // success (e.g. a 204) is fine.
  const signInPage = response.status === 203 || (response.ok && text.trim() !== '' && !isJson);
  if (!response.ok || signInPage) {
    const status = signInPage ? 401 : response.status;
    let detail = signInPage ? 'the token was not accepted' : response.statusText;
    if (isJson && !signInPage) {
      try {
        detail = (JSON.parse(text) as { message?: string }).message || detail;
      } catch {
        // Keep the status text.
      }
    }
    throw Object.assign(new Error(`Azure DevOps ${method} ${path} failed (${status}): ${detail}`), { status });
  }

  return (text.trim() ? JSON.parse(text) : undefined) as T;
};

/** Credentials for `git` against `collectionUri`, through the environment rather than the command line. */
const azureGitEnv = (collectionUri: string, token: string): Record<string, string> =>
  gitConfigEnv([[`http.${collectionUri}.extraheader`, `AUTHORIZATION: ${azureAuthorization(token)}`]]);

// --- Links -------------------------------------------------------------------------------------------

export const azurePullRequestUrl = (repository: AzureRepository, prNumber: number): string =>
  `${repositoryUrl(repository)}/pullrequest/${prNumber}`;

export const azureFileUrl = (repository: AzureRepository, sha: string, path: string, line: number): string =>
  `${repositoryUrl(repository)}?${new URLSearchParams({
    path: `/${path}`,
    version: `GC${sha}`,
    line: String(line),
    lineEnd: String(line + 1),
    lineStartColumn: '1',
    lineEndColumn: '1',
    lineStyle: 'plain',
    _a: 'contents',
  }).toString()}`;

export const azureTreeUrl = (repository: AzureRepository, ref: string, path?: string): string =>
  `${repositoryUrl(repository)}?${new URLSearchParams({ ...(path ? { path: `/${path}` } : {}), version: `GB${ref}` }).toString()}`;

export const azureSourceRepository = (target: AzureDevOpsReviewTarget): AzureRepository => ({
  collectionUri: target.collectionUri,
  project: target.project,
  repository: target.repository,
});

/** GitHub markdown as Azure DevOps renders it. The marker that finds the comment lives in a thread property instead. */
export const toAzureDevOpsMarkdown = (markdown: string): string =>
  withoutGithubExtensions(replaceCommentMarker(markdown, () => ''));

// --- Source pull request -------------------------------------------------------------------------------

/** Azure DevOps thread statuses: a warning is active, information is closed, a cleared warning is fixed. */
const THREAD_STATUS: Record<CommentTone, 'active' | 'closed' | 'fixed'> = {
  info: 'closed',
  warning: 'active',
  resolved: 'fixed',
};

type Thread = {
  id: number;
  isDeleted?: boolean;
  properties?: Record<string, { $value?: unknown } | undefined>;
  comments?: { id: number; isDeleted?: boolean }[];
};

export const createAzureDevOpsSource = (target: AzureDevOpsReviewTarget & { prNumber: number }): SourcePullRequestProvider => {
  const repository = { ...azureSourceRepository(target), repository: target.repositoryId };
  const pullRequestUrl = azurePullRequestUrl(azureSourceRepository(target), target.prNumber);
  const call = <T>(method: string, path: string, body?: unknown) =>
    request<T>(target.token, method, apiUrl(repository, `/pullRequests/${target.prNumber}${path}`), body);

  return {
    name: 'azure-devops',

    async upsertComment(marker: string, body: string, { onlyUpdateExisting = false, tone }: UpsertCommentOptions) {
      const content = toAzureDevOpsMarkdown(body);
      const status = THREAD_STATUS[tone];
      const { value: threads } = await call<{ value: Thread[] }>('GET', '/threads');
      const existing = threads.find((thread) => !thread.isDeleted && thread.properties?.[MARKER_PROPERTY]?.$value === marker);
      const comment = existing?.comments?.find((candidate) => !candidate.isDeleted);

      if (existing && comment) {
        await call('PATCH', `/threads/${existing.id}/comments/${comment.id}`, { content });
        await call('PATCH', `/threads/${existing.id}`, { status });
        const url = `${pullRequestUrl}?discussionId=${existing.id}`;
        console.error(`[eventcatalog:azure-devops] Updated pull request comment: ${url}`);
        return url;
      }

      if (onlyUpdateExisting) return undefined;

      const thread = await call<Thread>('POST', '/threads', {
        comments: [{ parentCommentId: 0, content, commentType: 'text' }],
        status,
        properties: { [MARKER_PROPERTY]: { $type: 'System.String', $value: marker } },
      });
      const url = `${pullRequestUrl}?discussionId=${thread.id}`;
      console.error(`[eventcatalog:azure-devops] Created pull request comment: ${url}`);
      return url;
    },

    async getDescription() {
      const pullRequest = await call<{ description?: string }>('GET', '');
      return pullRequest.description ?? undefined;
    },
  };
};

type PullRequestQuery = {
  results?: Record<
    string,
    { pullRequestId: number; status?: string; lastMergeTargetCommit?: { commitId?: string } }[] | undefined
  >[];
};

/**
 * The pull request that merged as `commitId`: how a build of the target branch after a merge finds the
 * pull request to comment on, and the target branch commit it merged onto. Undefined when no completed
 * pull request merged it (a direct push, or a pull request that is still active or was abandoned).
 */
export const findMergedPullRequest = async (
  target: AzureDevOpsReviewTarget,
  commitId: string
): Promise<{ prNumber: number; targetCommit?: string } | undefined> => {
  const repository = { ...azureSourceRepository(target), repository: target.repositoryId };
  const query = await request<PullRequestQuery>(
    target.token,
    'POST',
    apiUrl(repository, '/pullrequestquery'),
    { queries: [{ type: 'lastMergeCommit', items: [commitId] }] },
    { safeToRepeat: true } // A read, sent as a POST.
  );
  const pullRequests = query.results?.[0]?.[commitId] ?? [];
  const pullRequest = pullRequests.find((candidate) => candidate.status === 'completed');
  return pullRequest
    ? { prNumber: pullRequest.pullRequestId, targetCommit: pullRequest.lastMergeTargetCommit?.commitId }
    : undefined;
};

// --- Catalog repository --------------------------------------------------------------------------------

type PullRequest = {
  pullRequestId: number;
  status: 'active' | 'completed' | 'abandoned' | string;
  sourceRefName: string;
  closedDate?: string;
};

export const createAzureDevOpsCatalog = (
  config: Pick<ReviewConfig, 'catalogRepo' | 'catalogToken' | 'azureDevOpsOrganization'>
): CatalogRepositoryProvider => {
  const repository = parseAzureRepository(config.catalogRepo, config.azureDevOpsOrganization);

  if (!repository) {
    const isShortForm = Boolean(config.catalogRepo?.trim()) && !/^https?:\/\//i.test(config.catalogRepo?.trim() ?? '');
    throw new Error(
      isShortForm && !config.azureDevOpsOrganization
        ? `The catalog repository "${config.catalogRepo}" needs an Azure DevOps organization: outside Azure Pipelines, use its full URL, such as https://dev.azure.com/org/Project/_git/Repo.`
        : 'An Azure Repos catalog repository is required: `Project/Repo`, or a full URL such as https://dev.azure.com/org/Project/_git/Repo.'
    );
  }

  if (!config.catalogToken) {
    throw new Error('A catalog token is required to access the EventCatalog repository.');
  }

  const token = config.catalogToken;
  const name = `${repository.project}/${repository.repository}`;
  const call = <T>(method: string, path: string, query?: Record<string, string>, body?: unknown) =>
    request<T>(token, method, apiUrl(repository, path, query), body);

  return {
    name: 'azure-devops',

    async preflight(ref: string): Promise<CatalogPreflightResult> {
      try {
        await call('GET', '');
      } catch (error) {
        throw Object.assign(new Error(`Catalog token cannot access ${name}: ${(error as Error).message}`), {
          status: (error as { status?: number }).status,
        });
      }

      const { value: refs } = await call<{ value: { name: string; objectId: string }[] }>('GET', '/refs', {
        filter: `heads/${ref}`,
      });
      const branch = refs.find((candidate) => candidate.name === `refs/heads/${ref}`);

      if (!branch) {
        throw Object.assign(new Error(`Catalog ref "${ref}" was not found in ${name}`), { status: 404 });
      }

      return { branchSha: branch.objectId, fullName: name };
    },

    cloneUrl: () => repositoryUrl(repository),

    gitEnv: () => azureGitEnv(repository.collectionUri, token),

    async upsertPullRequest({ branch, base, title, body }: CatalogPullRequestInput) {
      const description = fitMarkdown(
        toAzureDevOpsMarkdown(body),
        MAX_DESCRIPTION_LENGTH,
        '\n\n_…shortened to fit Azure DevOps’ 4000-character limit._'
      );
      const fittedTitle = fitLength(title, MAX_TITLE_LENGTH, '…');
      const { value: existing } = await call<{ value: PullRequest[] }>('GET', '/pullrequests', {
        'searchCriteria.sourceRefName': `refs/heads/${branch}`,
        'searchCriteria.targetRefName': `refs/heads/${base}`,
        'searchCriteria.status': 'active',
      });

      if (existing[0]) {
        await call('PATCH', `/pullrequests/${existing[0].pullRequestId}`, undefined, { title: fittedTitle, description });
        const url = azurePullRequestUrl(repository, existing[0].pullRequestId);
        console.error(`[eventcatalog:catalog-pr] Updated catalog pull request: ${url}`);
        return url;
      }

      const created = await call<PullRequest>('POST', '/pullrequests', undefined, {
        sourceRefName: `refs/heads/${branch}`,
        targetRefName: `refs/heads/${base}`,
        title: fittedTitle,
        description,
      });
      const url = azurePullRequestUrl(repository, created.pullRequestId);
      console.error(`[eventcatalog:catalog-pr] Created catalog pull request: ${url}`);
      return url;
    },

    async getAgentPullRequestStats(branchPrefix: string): Promise<AgentPullRequestStats> {
      const { value } = await call<{ value: PullRequest[] }>('GET', '/pullrequests', {
        'searchCriteria.status': 'all',
        $top: '100',
      });

      const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const recent = (date: string | undefined) => Boolean(date && Date.parse(date) >= since);
      const agentPullRequests = value.filter((pullRequest) => pullRequest.sourceRefName.startsWith(`refs/heads/${branchPrefix}`));

      return {
        open: agentPullRequests.filter((pullRequest) => pullRequest.status === 'active').length,
        merged30d: agentPullRequests.filter((pullRequest) => pullRequest.status === 'completed' && recent(pullRequest.closedDate))
          .length,
        closedUnmerged30d: agentPullRequests.filter(
          (pullRequest) => pullRequest.status === 'abandoned' && recent(pullRequest.closedDate)
        ).length,
      };
    },
  };
};
