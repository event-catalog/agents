import type { BitbucketReviewTarget, ReviewConfig } from '@/src/config';
import {
  findMergedPullRequest,
  getPipelineTrigger,
  getPullRequestCommitMessages,
  requireBitbucketToken,
} from '@/src/providers/bitbucket';
import { commitParents, git, resolveCommit } from '@/src/utils/git';

/**
 * What a Bitbucket pipeline needs from git and the API before it can review: the commits to diff, and
 * for a pipeline of the target branch after a merge, the pull request that merged.
 */

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
    const [first, second] = await commitParents(workspace, 'HEAD').catch(() => []);
    if (second && first === headSha) baseSha = second;
  }

  if (!baseSha) throw new Error(SHALLOW_CLONE);
  return { baseSha, headSha };
};

const normaliseMessage = (message: string): string => message.replace(/\r\n/g, '\n').trim();

/**
 * Where the pull request's changes start, below the commit the target branch is at after the merge.
 *
 * - A merge commit (two parents): its first parent, the target branch before the merge.
 * - One commit (a squash, or a pull request of one commit): its parent.
 * - Several commits added to the target branch as they are (fast-forward, or rebase and fast-forward):
 *   below the last of them. Bitbucket doesn't record which strategy merged a pull request, so the
 *   commits are recognised by their messages, which a rebase keeps: when the last commits on the target
 *   branch carry the pull request's commit messages, they are its commits. Otherwise it was squashed.
 *   If the source branch merged the target branch in to stay up to date, the target branch commit it
 *   merged is the base, not the commit below the pull request's first commit.
 *
 * Known limit: when the source branch merged in another branch's commits, the pull request lists more
 * commits than the target branch's first-parent history shows, so the messages don't match and only the
 * last commit is reviewed.
 */
const resolveMergedRange = async (
  workspace: string,
  target: BitbucketReviewTarget & { prNumber: number },
  commit: string
): Promise<string> => {
  const [firstParent, secondParent] = await commitParents(workspace, commit).catch(() => []);
  if (!firstParent) throw new Error(SHALLOW_CLONE);
  if (secondParent) return firstParent;

  const messages = await getPullRequestCommitMessages(target, target.prNumber).catch((error: Error) => {
    console.error(`[eventcatalog:bitbucket] Could not list the pull request's commits: ${error.message}`);
    return undefined;
  });
  const count = messages?.length ?? 0;
  if (count <= 1) return firstParent;

  const onBranch = (await git(workspace, ['log', '--first-parent', `-n${count}`, '--format=%B%x00', commit]))
    .split('\0')
    .map(normaliseMessage)
    .filter(Boolean);
  const sorted = (values: string[]) => values.map(normaliseMessage).sort().join('\0');
  if (onBranch.length !== count || sorted(onBranch) !== sorted(messages ?? [])) return firstParent;

  const synced = await syncedTargetCommit(workspace, commit, count);
  if (synced) return synced;

  const base = await resolveCommit(workspace, `${commit}~${count}`);
  if (!base) throw new Error(SHALLOW_CLONE);
  return base;
};

/**
 * For a fast-forward of a source branch that merged the target branch in: the target branch commit the
 * newest of those merges brought in. `commit~count` would follow the source branch below the merge to
 * where it forked, and the diff would include everything the target branch gained in between. It is the
 * base only if exactly the pull request's `count` commits are reachable from `commit` and not from it.
 */
const syncedTargetCommit = async (workspace: string, commit: string, count: number): Promise<string | undefined> => {
  const chain = (await git(workspace, ['rev-list', '--first-parent', `-n${count}`, commit])).split('\n').filter(Boolean);
  for (const sha of chain) {
    const [, mergedIn] = await commitParents(workspace, sha);
    if (!mergedIn) continue;
    const between = Number(await git(workspace, ['rev-list', '--count', `${mergedIn}..${commit}`]));
    return between === count ? mergedIn : undefined;
  }
  return undefined;
};

/**
 * After a merge: skips a scheduled pipeline, which isn't about a merge, then finds the pull request that
 * merged, so a direct push is skipped before anything needs the history.
 */
const resolveMergedPullRequest = async (config: ReviewConfig, target: BitbucketReviewTarget): Promise<ReviewConfig> => {
  const trigger = await getPipelineTrigger(target);
  if (trigger === 'schedule') {
    return {
      ...config,
      skipReason: 'This Bitbucket pipeline ran on a schedule, not after a merge, so there is nothing to review.',
    };
  }

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
  const withPullRequest = { ...target, prNumber: merged.prNumber };
  if (config.baseSha && config.headSha) return { ...config, bitbucket: withPullRequest };

  const baseSha = await resolveMergedRange(config.workspace, withPullRequest, commit);
  return { ...config, bitbucket: withPullRequest, baseSha, headSha: commit };
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
