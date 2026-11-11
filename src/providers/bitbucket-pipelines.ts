import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BitbucketReviewTarget, ReviewConfig } from '@/src/config';
import { findMergedPullRequest, requireBitbucketToken, sameCommit } from '@/src/providers/bitbucket';

/**
 * What a Bitbucket pipeline needs from git and the API before it can review: the commits to diff, and
 * for a pipeline of the target branch after a merge, the pull request that merged.
 */

const execFileAsync = promisify(execFile);

const git = async (workspace: string, args: string[]): Promise<string> =>
  (await execFileAsync('git', ['-C', workspace, ...args])).stdout.trim();

/** The full hash of `ref` when the checkout has that commit (Bitbucket's hashes can be abbreviated). */
const resolveCommit = (workspace: string, ref: string | undefined): Promise<string | undefined> =>
  ref
    ? git(workspace, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).then(
        (sha) => sha || undefined,
        () => undefined
      )
    : Promise.resolve(undefined);

const isAncestor = (workspace: string, ancestor: string, commit: string): Promise<boolean> =>
  git(workspace, ['merge-base', '--is-ancestor', ancestor, commit]).then(
    () => true,
    () => false
  );

const parents = async (workspace: string, ref: string): Promise<string[]> =>
  (await git(workspace, ['rev-list', '--parents', '-n', '1', ref])).split(/\s+/).slice(1);

const SHALLOW_CLONE =
  'Cannot find the commits to compare. Clone the repository in full (`clone: depth: full` on the step) so the agent can diff the pull request.';

/**
 * A pull request pipeline: from the pull request's source commit (`BITBUCKET_COMMIT`) back to where it
 * left the target branch. Bitbucket merges the target branch into the checkout before the step runs, so
 * the target branch commit is the merge's second parent when the variable for it is missing.
 */
const resolvePullRequestRange = async (
  workspace: string,
  target: BitbucketReviewTarget
): Promise<{ baseSha: string; headSha: string }> => {
  const headSha = (await resolveCommit(workspace, target.commit)) ?? (await git(workspace, ['rev-parse', 'HEAD']));
  let baseSha = await resolveCommit(workspace, target.destinationCommit);

  if (!baseSha) {
    const [first, second] = await parents(workspace, 'HEAD').catch(() => []);
    if (second && first === headSha) baseSha = second;
  }

  if (!baseSha) throw new Error(SHALLOW_CLONE);
  return { baseSha, headSha };
};

/**
 * After a merge: finds the pull request that merged first, so a direct push is skipped before anything
 * needs the history. A merge commit or squashed commit diffs against its first parent, the target branch
 * before the change. A fast-forward merge has no such commit, so it diffs from the target branch commit
 * the pull request was opened against.
 */
const resolveMergedPullRequest = async (config: ReviewConfig, target: BitbucketReviewTarget): Promise<ReviewConfig> => {
  const commit = (await resolveCommit(config.workspace, target.commit)) ?? (await git(config.workspace, ['rev-parse', 'HEAD']));
  const branch = target.branch;
  const merged = branch ? await findMergedPullRequest(target, commit, branch) : undefined;

  if (!merged) {
    return {
      ...config,
      skipReason: `No pull request merged as commit ${commit.slice(0, 12)}${branch ? ` into ${branch}` : ''} (a direct push?), so there is nothing to review.`,
    };
  }

  console.error(`[eventcatalog:bitbucket] Commit ${commit.slice(0, 12)} was merged by pull request #${merged.prNumber}`);
  const withPullRequest = { ...config, bitbucket: { ...target, prNumber: merged.prNumber } };
  if (config.baseSha && config.headSha) return withPullRequest;

  const [firstParent, secondParent] = await parents(config.workspace, commit).catch(() => []);
  if (!firstParent) throw new Error(SHALLOW_CLONE);

  let baseSha = firstParent;
  if (!secondParent && sameCommit(merged.sourceCommit, commit)) {
    const destination = await resolveCommit(config.workspace, merged.destinationCommit);
    if (destination && destination !== commit && (await isAncestor(config.workspace, destination, commit))) {
      baseSha = destination;
    }
  }

  return { ...withPullRequest, baseSha, headSha: commit };
};

export const resolveBitbucketPipelinesContext = async (config: ReviewConfig): Promise<ReviewConfig> => {
  const target = config.bitbucket;
  if (!target || config.skipReason) return config;
  requireBitbucketToken(target);

  if (config.pullRequestState === 'merged' && target.prNumber === undefined) {
    return resolveMergedPullRequest(config, target);
  }

  if (config.baseSha && config.headSha) return config;
  return { ...config, ...(await resolvePullRequestRange(config.workspace, target)) };
};
