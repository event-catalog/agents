import type { SourceControlProvider } from '@/src/config';

/**
 * The agents' only contact with a Git hosting service (GitHub, Azure DevOps, Bitbucket). Everything else — diffs,
 * planning, catalog edits, comment and pull request text — is shared and does not know where it runs.
 *
 * A run has two roles, and each can be on a different provider:
 * - the **source** pull request the agent reviews and comments on, and
 * - the **catalog** repository where Code-to-Docs opens its documentation pull requests.
 */

/**
 * What a comment says, so a provider can show it the way its users expect. GitHub comments have no
 * state; Azure DevOps opens a thread as active (a warning to look at), closed (for information), or
 * resolved (an earlier warning that no longer applies); Bitbucket resolves a comment whose warning no
 * longer applies, and reopens it when a warning comes back.
 */
export type CommentTone = 'info' | 'warning' | 'resolved';

export interface UpsertCommentOptions {
  /** Update the earlier comment if there is one, but never create a new one. */
  onlyUpdateExisting?: boolean;
  tone: CommentTone;
}

/** The source pull request: where the agents comment, and where they read the description from. */
export interface SourcePullRequestProvider {
  readonly name: SourceControlProvider;
  /**
   * Creates the agent's comment, or updates the earlier one that carries `marker`, so reruns replace
   * the comment instead of stacking up new ones. Returns the comment's URL.
   */
  upsertComment(marker: string, body: string, options: UpsertCommentOptions): Promise<string | undefined>;
  /** The pull request description as it is now. */
  getDescription(): Promise<string | undefined>;
}

export interface CatalogPreflightResult {
  branchSha: string;
  fullName: string;
}

/** How the agent's catalog pull requests have fared: the signal for whether its work gets merged. */
export interface AgentPullRequestStats {
  open: number;
  merged30d: number;
  closedUnmerged30d: number;
}

export interface CatalogPullRequestInput {
  /** The branch the agent pushed, without `refs/heads/`. */
  branch: string;
  /** The branch to merge into (`catalog-ref`). */
  base: string;
  title: string;
  /** GitHub-flavoured markdown; providers adapt it to what they render. */
  body: string;
}

/** The catalog repository, where Code-to-Docs pushes a branch and opens a pull request. */
export interface CatalogRepositoryProvider {
  readonly name: SourceControlProvider;
  /** Checks the token can reach the repository and that `ref` exists, before any model work. */
  preflight(ref: string): Promise<CatalogPreflightResult>;
  /** The HTTPS URL to clone and push the repository with. */
  cloneUrl(): string;
  /**
   * Environment for `git` commands that talk to the remote. Credentials go in the environment, never
   * on the command line, so a failed command's error message can't print them.
   */
  gitEnv(): Record<string, string>;
  /** Opens a pull request from `branch`, or updates the open one. Returns its web URL. */
  upsertPullRequest(input: CatalogPullRequestInput): Promise<string>;
  /** Counts the agent's pull requests (branches starting with `branchPrefix`). Reads only states and dates. */
  getAgentPullRequestStats(branchPrefix: string): Promise<AgentPullRequestStats>;
}

/** An HTTP failure from a provider API, with its status so errors can be classified. */
export type RequestErrorLike = Error & { status?: number };
