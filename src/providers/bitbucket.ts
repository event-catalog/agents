import type { BitbucketReviewTarget, ReviewConfig } from '@/src/config';
import { sendWithRetry } from '@/src/providers/http';
import { COMMENT_MARKER_LINE, fitLength, fitMarkdown, markerId, withoutGithubExtensions } from '@/src/providers/markdown';
import type {
  AgentPullRequestStats,
  CatalogPreflightResult,
  CatalogPullRequestInput,
  CatalogRepositoryProvider,
  SourcePullRequestProvider,
  UpsertCommentOptions,
} from '@/src/providers/types';
import { gitConfigEnv } from '@/src/utils/git';

/**
 * Bitbucket Cloud: pull request comments and catalog pull requests, through the REST API (2.0).
 * Authenticates with an access token (repository, project or workspace), sent as a bearer token, or an
 * Atlassian API token written as `email:token`, sent with basic auth. Bitbucket Data Center has a
 * different API and isn't supported.
 */

const WEB_URL = 'https://bitbucket.org';
const API_URL = 'https://api.bitbucket.org/2.0';

const MAX_TITLE_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 32_000;
/** Pages of comments or pull requests to read at most, so a busy repository can't make a run hang. */
const MAX_PAGES = 10;

export interface BitbucketRepository {
  /** The workspace's slug. */
  workspace: string;
  /** The repository's slug. */
  repository: string;
}

const SLUG = /^[\w.-]+$/;

/**
 * Reads a Bitbucket repository from the `catalog-repo` setting: `workspace/repo`, just `repo` (in the
 * pipeline's own workspace), or a URL such as `https://bitbucket.org/workspace/repo` or the clone URL
 * `https://user@bitbucket.org/workspace/repo.git`.
 */
export const parseBitbucketRepository = (
  value: string | undefined,
  defaultWorkspace?: string
): BitbucketRepository | undefined => {
  let trimmed = value?.trim().replace(/\/+$/, '');
  if (!trimmed) return undefined;

  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return undefined;
    }
    if (url.hostname.toLowerCase() !== 'bitbucket.org') return undefined;
    // Only the path is read, so the user name in a copied clone URL is dropped.
    const [workspace, repository] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    trimmed = workspace && repository ? `${workspace}/${repository}` : '';
  }

  const parts = trimmed.replace(/\.git$/, '').split('/');
  const [workspace, repository] = parts.length === 1 ? [defaultWorkspace, parts[0]] : parts;
  if (parts.length > 2 || !workspace || !repository || !SLUG.test(workspace) || !SLUG.test(repository)) return undefined;
  return { workspace, repository };
};

/** An API token is written `email:token` and sent with basic auth; an access token is a bearer token. */
const isApiToken = (token: string): boolean => token.includes(':');

export const bitbucketAuthorization = (token: string): string =>
  isApiToken(token) ? `Basic ${Buffer.from(token).toString('base64')}` : `Bearer ${token}`;

/** Credentials for `git` against one repository, through the environment rather than the command line. */
const bitbucketGitEnv = (repository: BitbucketRepository, token: string): Record<string, string> => {
  // Bitbucket's documented git user names: `x-token-auth` for access tokens, and a fixed one for API tokens.
  const credentials = isApiToken(token)
    ? `x-bitbucket-api-token-auth:${token.slice(token.indexOf(':') + 1)}`
    : `x-token-auth:${token}`;
  return gitConfigEnv([
    [`http.${cloneUrl(repository)}.extraheader`, `AUTHORIZATION: Basic ${Buffer.from(credentials).toString('base64')}`],
  ]);
};

const repositoryPath = ({ workspace, repository }: BitbucketRepository): string =>
  `${encodeURIComponent(workspace)}/${encodeURIComponent(repository)}`;

const apiUrl = (repository: BitbucketRepository, path: string, query: Record<string, string> = {}): string => {
  const search = new URLSearchParams(query).toString();
  return `${API_URL}/repositories/${repositoryPath(repository)}${path}${search ? `?${search}` : ''}`;
};

const cloneUrl = (repository: BitbucketRepository): string => `${WEB_URL}/${repositoryPath(repository)}.git`;

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
        Authorization: bitbucketAuthorization(token),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const response = await sendWithRetry(send, safeToRepeat);
  const text = await response.text();

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; detail?: unknown } };
      detail = parsed.error?.message || detail;
    } catch {
      // Keep the status text.
    }
    if (response.status === 401) detail = `${detail || 'Unauthorized'}: the token was not accepted`;
    const path = new URL(url).pathname;
    throw Object.assign(new Error(`Bitbucket ${method} ${path} failed (${response.status}): ${detail}`), {
      status: response.status,
    });
  }

  return (text.trim() ? JSON.parse(text) : undefined) as T;
};

type Page<T> = { values: T[]; next?: string };

/** A string in a Bitbucket query (`q=`), quoted. */
const bbqlString = (value: string): string => `"${value.replace(/["\\]/g, '')}"`;

/** Every item of a paginated list, up to `MAX_PAGES` pages. */
const listAll = async <T>(token: string, url: string): Promise<T[]> => {
  const items: T[] = [];
  let next: string | undefined = url;
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const result: Page<T> = await request<Page<T>>(token, 'GET', next);
    items.push(...result.values);
    next = result.next;
  }
  return items;
};

// --- Links -------------------------------------------------------------------------------------------

export const bitbucketPullRequestUrl = (repository: BitbucketRepository, prNumber: number): string =>
  `${WEB_URL}/${repositoryPath(repository)}/pull-requests/${prNumber}`;

export const bitbucketFileUrl = (repository: BitbucketRepository, sha: string, path: string, line: number): string =>
  `${WEB_URL}/${repositoryPath(repository)}/src/${sha}/${encodeURI(path)}#lines-${line}`;

export const bitbucketTreeUrl = (repository: BitbucketRepository, ref: string, path?: string): string =>
  `${WEB_URL}/${repositoryPath(repository)}/src/${encodeURI(ref)}/${path ? encodeURI(path) : ''}`;

export const bitbucketSourceRepository = (target: BitbucketReviewTarget): BitbucketRepository => ({
  workspace: target.workspace,
  repository: target.repository,
});

/**
 * GitHub markdown as Bitbucket renders it. Bitbucket shows raw HTML as text, so the comment marker
 * becomes a markdown reference definition, which keeps it in the comment's source but out of sight.
 */
export const toBitbucketMarkdown = (markdown: string): string =>
  withoutGithubExtensions(markdown.replace(COMMENT_MARKER_LINE, (_, id: string) => `[//]: # (${id})\n\n`));

// --- Source pull request -------------------------------------------------------------------------------

type Comment = {
  id: number;
  deleted?: boolean;
  parent?: { id: number };
  inline?: unknown;
  content?: { raw?: string };
  resolution?: unknown;
  links?: { html?: { href?: string } };
};

/** A token is required in Bitbucket: Pipelines has no built-in token for the REST API. */
export const requireBitbucketToken = (target: Pick<BitbucketReviewTarget, 'token'>): string => {
  if (!target.token) {
    throw new Error(
      'Bitbucket needs an access token to comment on pull requests: add one as the EVENTCATALOG_BITBUCKET_TOKEN secured repository variable, with the Pull requests: Write permission.'
    );
  }
  return target.token;
};

export const createBitbucketSource = (target: BitbucketReviewTarget & { prNumber: number }): SourcePullRequestProvider => {
  const token = requireBitbucketToken(target);
  const repository = bitbucketSourceRepository(target);
  const pullRequestUrl = bitbucketPullRequestUrl(repository, target.prNumber);
  const url = (path: string, query?: Record<string, string>) =>
    apiUrl(repository, `/pullrequests/${target.prNumber}${path}`, query);
  const call = <T>(method: string, path: string, body?: unknown) => request<T>(token, method, url(path), body);

  /**
   * Resolves an ADR warning that no longer applies, and reopens a comment that has a warning again.
   * Resolving is best effort: the comment's text already says whether the warning applies.
   */
  const syncResolution = async (comment: Comment, resolve: boolean) => {
    if (resolve === Boolean(comment.resolution)) return;
    try {
      await call(resolve ? 'POST' : 'DELETE', `/comments/${comment.id}/resolve`);
    } catch (error) {
      console.error(
        `[eventcatalog:bitbucket] Could not ${resolve ? 'resolve' : 'reopen'} the comment: ${(error as Error).message}`
      );
    }
  };

  return {
    name: 'bitbucket',

    async upsertComment(marker: string, body: string, { onlyUpdateExisting = false, tone }: UpsertCommentOptions) {
      const raw = toBitbucketMarkdown(body);
      const tag = `(${markerId(marker)})`;
      const comments = await listAll<Comment>(token, url('/comments', { pagelen: '100' }));
      const existing = comments.find(
        (comment) => !comment.deleted && !comment.parent && !comment.inline && comment.content?.raw?.includes(tag)
      );

      if (existing) {
        const updated = await call<Comment>('PUT', `/comments/${existing.id}`, { content: { raw } });
        await syncResolution(existing, tone === 'resolved');
        const link = updated?.links?.html?.href ?? `${pullRequestUrl}#comment-${existing.id}`;
        console.error(`[eventcatalog:bitbucket] Updated pull request comment: ${link}`);
        return link;
      }

      if (onlyUpdateExisting) return undefined;

      const created = await call<Comment>('POST', '/comments', { content: { raw } });
      const link = created.links?.html?.href ?? `${pullRequestUrl}#comment-${created.id}`;
      console.error(`[eventcatalog:bitbucket] Created pull request comment: ${link}`);
      return link;
    },

    async getDescription() {
      const pullRequest = await call<{ description?: string }>('GET', '');
      return pullRequest.description || undefined;
    },
  };
};

type PullRequest = {
  id: number;
  state: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED' | string;
  source?: { branch?: { name?: string }; commit?: { hash?: string } };
  destination?: { branch?: { name?: string }; commit?: { hash?: string } };
  merge_commit?: { hash?: string } | null;
  updated_on?: string;
  links?: { html?: { href?: string } };
};

/** Bitbucket often gives abbreviated hashes: two hashes match when one starts with the other. */
export const sameCommit = (a: string | undefined, b: string | undefined): boolean =>
  Boolean(a && b && a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a)));

/**
 * The pull request that merged into `branch` as `commit`: how a pipeline of the target branch after a
 * merge finds the pull request to comment on. Bitbucket has no lookup by merge commit, so this checks
 * the pull requests merged into the branch most recently. Undefined for a direct push.
 */
export const findMergedPullRequest = async (
  target: BitbucketReviewTarget,
  commit: string,
  branch: string
): Promise<{ prNumber: number; sourceCommit?: string; destinationCommit?: string } | undefined> => {
  const token = requireBitbucketToken(target);
  const { values } = await request<Page<PullRequest>>(
    token,
    'GET',
    apiUrl(bitbucketSourceRepository(target), '/pullrequests', {
      state: 'MERGED',
      q: `destination.branch.name = ${bbqlString(branch)}`,
      sort: '-updated_on',
      pagelen: '50',
    })
  );
  const pullRequest = values.find((candidate) => sameCommit(candidate.merge_commit?.hash, commit));
  return pullRequest
    ? {
        prNumber: pullRequest.id,
        sourceCommit: pullRequest.source?.commit?.hash,
        destinationCommit: pullRequest.destination?.commit?.hash,
      }
    : undefined;
};

// --- Catalog repository --------------------------------------------------------------------------------

export const createBitbucketCatalog = (
  config: Pick<ReviewConfig, 'catalogRepo' | 'catalogToken'> & Partial<Pick<ReviewConfig, 'bitbucketWorkspace'>>
): CatalogRepositoryProvider => {
  const repository = parseBitbucketRepository(config.catalogRepo, config.bitbucketWorkspace);

  if (!repository) {
    throw new Error(
      'A Bitbucket catalog repository is required: `workspace/repo`, or a URL such as https://bitbucket.org/workspace/repo.'
    );
  }

  if (!config.catalogToken) {
    throw new Error('A catalog token is required to access the EventCatalog repository.');
  }

  const token = config.catalogToken;
  const name = `${repository.workspace}/${repository.repository}`;
  const call = <T>(method: string, path: string, query?: Record<string, string>, body?: unknown) =>
    request<T>(token, method, apiUrl(repository, path, query), body);

  return {
    name: 'bitbucket',

    async preflight(ref: string): Promise<CatalogPreflightResult> {
      let fullName = name;
      try {
        fullName = (await call<{ full_name?: string }>('GET', '')).full_name ?? name;
      } catch (error) {
        throw Object.assign(new Error(`Catalog token cannot access ${name}: ${(error as Error).message}`), {
          status: (error as { status?: number }).status,
        });
      }

      try {
        const branch = await call<{ target?: { hash?: string } }>(
          'GET',
          `/refs/branches/${ref.split('/').map(encodeURIComponent).join('/')}`
        );
        return { branchSha: branch.target?.hash ?? '', fullName };
      } catch (error) {
        throw Object.assign(new Error(`Catalog ref "${ref}" was not found in ${name}: ${(error as Error).message}`), {
          status: (error as { status?: number }).status,
        });
      }
    },

    cloneUrl: () => cloneUrl(repository),

    gitEnv: () => bitbucketGitEnv(repository, token),

    async upsertPullRequest({ branch, base, title, body }: CatalogPullRequestInput) {
      const description = fitMarkdown(
        toBitbucketMarkdown(body),
        MAX_DESCRIPTION_LENGTH,
        '\n\n_…shortened to fit in a Bitbucket pull request description._'
      );
      const fittedTitle = fitLength(title, MAX_TITLE_LENGTH, '…');
      const { values: existing } = await call<Page<PullRequest>>('GET', '/pullrequests', {
        state: 'OPEN',
        q: `source.branch.name = ${bbqlString(branch)} AND destination.branch.name = ${bbqlString(base)}`,
      });

      if (existing[0]) {
        const updated = await call<PullRequest>('PUT', `/pullrequests/${existing[0].id}`, undefined, {
          title: fittedTitle,
          description,
        });
        const url = updated?.links?.html?.href ?? bitbucketPullRequestUrl(repository, existing[0].id);
        console.error(`[eventcatalog:catalog-pr] Updated catalog pull request: ${url}`);
        return url;
      }

      const created = await call<PullRequest>('POST', '/pullrequests', undefined, {
        title: fittedTitle,
        description,
        source: { branch: { name: branch } },
        destination: { branch: { name: base } },
        close_source_branch: true,
      });
      const url = created.links?.html?.href ?? bitbucketPullRequestUrl(repository, created.id);
      console.error(`[eventcatalog:catalog-pr] Created catalog pull request: ${url}`);
      return url;
    },

    async getAgentPullRequestStats(branchPrefix: string): Promise<AgentPullRequestStats> {
      // Without a state, Bitbucket lists only open pull requests.
      const query = new URLSearchParams({
        q: `source.branch.name ~ ${bbqlString(branchPrefix)}`,
        sort: '-updated_on',
        pagelen: '50',
      });
      for (const state of ['OPEN', 'MERGED', 'DECLINED']) query.append('state', state);
      const { values } = await request<Page<PullRequest>>(token, 'GET', `${apiUrl(repository, '/pullrequests')}?${query}`);

      const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const recent = (date: string | undefined) => Boolean(date && Date.parse(date) >= since);
      const agentPullRequests = values.filter((pullRequest) => pullRequest.source?.branch?.name?.startsWith(branchPrefix));

      // Bitbucket records no close date; the last update of a merged or declined pull request is when it closed.
      return {
        open: agentPullRequests.filter((pullRequest) => pullRequest.state === 'OPEN').length,
        merged30d: agentPullRequests.filter((pullRequest) => pullRequest.state === 'MERGED' && recent(pullRequest.updated_on))
          .length,
        closedUnmerged30d: agentPullRequests.filter(
          (pullRequest) => pullRequest.state === 'DECLINED' && recent(pullRequest.updated_on)
        ).length,
      };
    },
  };
};
