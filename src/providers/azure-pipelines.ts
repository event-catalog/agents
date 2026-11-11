import type { AzureDevOpsReviewTarget, ReviewConfig } from '@/src/config';
import { findMergedPullRequest } from '@/src/providers/azure-devops';
import { commitParents, git, resolveCommit } from '@/src/utils/git';

/**
 * What an Azure Pipelines build needs from git and the API before it can review: the commits to diff,
 * and for a build after a merge, the pull request that merged.
 */

/**
 * The commits to diff, from the commit the build checked out. A pull request build checks out the merge
 * of the source into the target branch, and a build after a merge checks out the merge commit (or the
 * squashed commit): either way the first parent is the target branch before the change, and the second
 * parent, when there is one, is the source branch.
 */
export const resolveMergeRange = async (workspace: string): Promise<{ baseSha: string; headSha: string }> => {
  const commit = await git(workspace, ['rev-parse', 'HEAD']);
  const [firstParent, secondParent] = await commitParents(workspace, commit);

  if (!firstParent) {
    throw new Error(
      'Cannot find the commits to compare: the checked-out commit has no parent. Check out the repository with `fetchDepth: 0` so the agent can diff the pull request.'
    );
  }

  return { baseSha: firstParent, headSha: secondParent ?? commit };
};

/**
 * After a merge: finds the pull request that merged first, so a build no pull request merged (a direct
 * push) is skipped before anything needs the history. Then diffs from the target branch commit the pull
 * request merged onto, which also covers a rebase and fast-forward (where the commit's parent is only
 * the pull request's previous commit).
 */
const resolveMergedPullRequest = async (config: ReviewConfig, target: AzureDevOpsReviewTarget): Promise<ReviewConfig> => {
  // `rev-parse HEAD` works in a shallow checkout too.
  const commit = target.commitId ?? (await git(config.workspace, ['rev-parse', 'HEAD']));
  const merged = await findMergedPullRequest(target, commit);

  if (!merged) {
    return {
      ...config,
      skipReason: `No completed pull request merged as commit ${commit.slice(0, 12)} (a direct push?), so there is nothing to review.`,
    };
  }

  console.error(`[eventcatalog:azure-devops] Commit ${commit.slice(0, 12)} was merged by pull request !${merged.prNumber}`);
  const withPullRequest = { ...config, azureDevOps: { ...target, prNumber: merged.prNumber } };
  if (config.baseSha && config.headSha) return withPullRequest;

  const range =
    merged.targetCommit && (await resolveCommit(config.workspace, merged.targetCommit))
      ? { baseSha: merged.targetCommit, headSha: commit }
      : await resolveMergeRange(config.workspace);
  return { ...withPullRequest, ...range };
};

export const resolveAzurePipelinesContext = async (config: ReviewConfig): Promise<ReviewConfig> => {
  const target = config.azureDevOps;
  if (!target || config.skipReason) return config;

  if (config.pullRequestState === 'merged' && target.prNumber === undefined) {
    return resolveMergedPullRequest(config, target);
  }

  if (config.baseSha && config.headSha) return config;
  return { ...config, ...(await resolveMergeRange(config.workspace)) };
};
