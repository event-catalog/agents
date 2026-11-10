import { Octokit } from 'octokit';
import type { GithubReviewTarget, ReviewConfig } from '@/src/config';
import { gitConfigEnv } from '@/src/utils/git';
import type {
  AgentPullRequestStats,
  CatalogPreflightResult,
  CatalogPullRequestInput,
  CatalogRepositoryProvider,
  RequestErrorLike,
  SourcePullRequestProvider,
  UpsertCommentOptions,
} from '@/src/providers/types';

/** GitHub: pull request comments (issue comments) and catalog pull requests, through Octokit. */

const GITHUB_URL = 'https://github.com';

export const parseGithubRepository = (repository: string | undefined): { owner: string; repo: string } | undefined => {
  const [owner, repo] = (repository ?? '').split('/');

  if (!owner || !repo) {
    return undefined;
  }

  return { owner, repo };
};

const isRequestErrorLike = (error: unknown): error is RequestErrorLike => error instanceof Error && 'status' in error;

export const formatRequestError = (error: unknown, fallback: string): Error => {
  if (!isRequestErrorLike(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  return Object.assign(new Error(`${fallback}: ${error.message}`), { status: error.status });
};

// --- Links -------------------------------------------------------------------------------------------

export const githubPullRequestUrl = ({ owner, repo, prNumber }: Pick<GithubReviewTarget, 'owner' | 'repo' | 'prNumber'>) =>
  `${GITHUB_URL}/${owner}/${repo}/pull/${prNumber}`;

export const githubFileUrl = (
  { owner, repo }: Pick<GithubReviewTarget, 'owner' | 'repo'>,
  sha: string,
  path: string,
  line: number
) => `${GITHUB_URL}/${owner}/${repo}/blob/${sha}/${encodeURI(path)}#L${line}`;

export const githubTreeUrl = (repository: string, ref: string, path?: string) =>
  `${GITHUB_URL}/${repository}/tree/${encodeURI(ref)}${path ? `/${encodeURI(path)}` : ''}`;

// --- Source pull request -------------------------------------------------------------------------------

export const createGithubSource = (target: GithubReviewTarget): SourcePullRequestProvider => {
  const { owner, repo, prNumber, token } = target;
  const octokit = new Octokit({ auth: token });

  return {
    name: 'github',

    async upsertComment(marker: string, body: string, { onlyUpdateExisting = false }: UpsertCommentOptions) {
      const { data: comments } = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: prNumber,
        per_page: 100,
      });

      const existingComment = comments.find((comment) => comment.body?.includes(marker));

      if (existingComment) {
        const { data } = await octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: existingComment.id,
          body,
        });

        console.error(`[eventcatalog:github] Updated pull request comment: ${data.html_url}`);
        return data.html_url;
      }

      if (onlyUpdateExisting) return undefined;

      const { data } = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body,
      });

      console.error(`[eventcatalog:github] Created pull request comment: ${data.html_url}`);
      return data.html_url;
    },

    async getDescription() {
      const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
      return data.body ?? undefined;
    },
  };
};

// --- Catalog repository --------------------------------------------------------------------------------

export const createGithubCatalog = (config: Pick<ReviewConfig, 'catalogRepo' | 'catalogToken'>): CatalogRepositoryProvider => {
  const repository = parseGithubRepository(config.catalogRepo);

  if (!repository) {
    throw new Error('A catalog repository in owner/repo format is required.');
  }

  if (!config.catalogToken) {
    throw new Error('A catalog token is required to access the EventCatalog repository.');
  }

  const token = config.catalogToken;
  const { owner, repo } = repository;
  const octokit = new Octokit({ auth: token });

  return {
    name: 'github',

    async preflight(ref: string): Promise<CatalogPreflightResult> {
      let fullName: string;
      let branchSha: string;

      try {
        const response = await octokit.rest.repos.get({ owner, repo });
        fullName = response.data.full_name;
      } catch (error) {
        throw formatRequestError(error, `Catalog token cannot access ${owner}/${repo}`);
      }

      try {
        const response = await octokit.rest.repos.getBranch({ owner, repo, branch: ref });
        branchSha = response.data.commit.sha;
      } catch (error) {
        throw formatRequestError(error, `Catalog ref "${ref}" was not found in ${owner}/${repo}`);
      }

      return { branchSha, fullName };
    },

    cloneUrl: () => `${GITHUB_URL}/${owner}/${repo}.git`,

    // In GitHub Actions, actions/checkout has already stored credentials for the catalog checkout.
    // Elsewhere (e.g. a GitHub catalog from Azure Pipelines), send the token the way actions/checkout does.
    gitEnv: () =>
      process.env.GITHUB_ACTIONS === 'true'
        ? {}
        : gitConfigEnv([
            [
              `http.${GITHUB_URL}/.extraheader`,
              `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
            ],
          ]),

    async upsertPullRequest({ branch, base, title, body }: CatalogPullRequestInput) {
      const { data: existingPullRequests } = await octokit.rest.pulls.list({
        owner,
        repo,
        head: `${owner}:${branch}`,
        base,
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
        return data.html_url;
      }

      const { data } = await octokit.rest.pulls.create({ owner, repo, head: branch, base, title, body });

      console.error(`[eventcatalog:catalog-pr] Created catalog pull request: ${data.html_url}`);
      return data.html_url;
    },

    async getAgentPullRequestStats(branchPrefix: string): Promise<AgentPullRequestStats> {
      const { data } = await octokit.rest.pulls.list({
        owner,
        repo,
        state: 'all',
        sort: 'updated',
        direction: 'desc',
        per_page: 100,
      });

      const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const recent = (date: string | null) => Boolean(date && Date.parse(date) >= since);
      const agentPullRequests = data.filter((pullRequest) => pullRequest.head.ref.startsWith(branchPrefix));

      return {
        open: agentPullRequests.filter((pullRequest) => pullRequest.state === 'open').length,
        merged30d: agentPullRequests.filter((pullRequest) => recent(pullRequest.merged_at)).length,
        closedUnmerged30d: agentPullRequests.filter((pullRequest) => !pullRequest.merged_at && recent(pullRequest.closed_at))
          .length,
      };
    },
  };
};
