import { PostHog } from 'posthog-node';
import { CLOSED_WITHOUT_MERGE_MESSAGE, isAzurePipelines, isBitbucketPipelines, type ReviewConfig } from '@/src/config';
import { MISSING_CATALOG_MESSAGE } from '@/src/utils/eventcatalog-utils';
import { getAgentPullRequestStats } from '@/src/utils/pull-requests/catalog-pr';

// Public Keys.
const DEFAULT_POSTHOG_KEY = 'phc_HQZncKORYsXgO87WuSjSdKbQSTzylljE6HTtUw0fBIH';
const DEFAULT_POSTHOG_HOST = 'https://e.eventcatalog.dev/relay-fBIH';

const POSTHOG_KEY = process.env.POSTHOG_KEY ?? process.env.EVENTCATALOG_POSTHOG_KEY ?? DEFAULT_POSTHOG_KEY;
const POSTHOG_HOST = process.env.POSTHOG_HOST || DEFAULT_POSTHOG_HOST;
const ENABLED = Boolean(POSTHOG_KEY);

// The outcome of a single PR-review run. Each value maps to one of the exit points in the
// pr-review workflow, so a dashboard split by `outcome` shows exactly what the action did.
export type PrReviewOutcome =
  | 'catalog_pr_created'
  | 'no_changes_required'
  | 'unauthorized_changes_blocked'
  | 'catalog_missing'
  | 'access_denied'
  | 'no_changed_files'
  | 'no_pull_request'
  | 'closed_without_merge'
  | 'error';

/**
 * Why a run failed, by category only: never the error message, which can contain repository
 * contents. Each category points at a different fix (a provider key, a GitHub token, the model).
 */
export type ErrorType =
  | 'model_provider_auth'
  | 'model_provider_billing'
  | 'model_rate_limit'
  | 'invalid_model_output'
  | 'github_access'
  | 'timeout'
  | 'unknown';

// The shape of whatever the workflow returned. We only read the few fields that tell us the
// outcome, so this stays loose on purpose and the workflow keeps returning its normal result.
// We deliberately do NOT read anything about the contents of a user's repo (file counts, paths,
// diffs) — only the high-level outcome of the run.
type PrReviewResult = {
  message?: string;
  catalogPullRequest?: { skipped?: boolean };
  unauthorizedCatalogChanges?: unknown;
  /** Set when the run had no pull request to review (e.g. an Azure Pipelines build of a direct push). */
  noPullRequest?: boolean;
};

// Derive the analytics outcome from a workflow result by its structure, so the workflow body
// never has to label its own exit points for analytics.
function outcomeFromResult(result: PrReviewResult): PrReviewOutcome {
  if (result.catalogPullRequest && !result.catalogPullRequest.skipped) return 'catalog_pr_created';
  if (result.unauthorizedCatalogChanges) return 'unauthorized_changes_blocked';
  if (result.message === MISSING_CATALOG_MESSAGE) return 'catalog_missing';
  if (result.message?.startsWith('EventCatalog agent skipped:')) return 'access_denied';
  if (result.message === 'No changed files found') return 'no_changed_files';
  if (result.message === CLOSED_WITHOUT_MERGE_MESSAGE) return 'closed_without_merge';
  if (result.noPullRequest) return 'no_pull_request';
  return 'no_changes_required';
}

/** Sorts an error into an `ErrorType` from its message and status. Only the category is reported. */
export function classifyError(error: unknown): ErrorType {
  // Flue wraps the provider's failure: `AgentRunError` → `cause` (e.g. `OperationFailedError`, whose
  // `meta.reason` holds the provider's response). Read the whole chain, not just the top message.
  const parts: string[] = [];
  let status: number | undefined;
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth++) {
    const record = (typeof current === 'object' ? current : {}) as {
      status?: unknown;
      meta?: { reason?: unknown };
      cause?: unknown;
    };
    parts.push(current instanceof Error ? `${current.name} ${current.message}` : String(current));
    if (typeof record.meta?.reason === 'string') parts.push(record.meta.reason);
    if (status === undefined && record.status !== undefined && Number.isFinite(Number(record.status)))
      status = Number(record.status);
    current = record.cause;
  }
  const text = parts.join(' ').toLowerCase();

  if (/credit balance|insufficient_quota|credit_balance|billing|quota exceeded/.test(text)) return 'model_provider_billing';
  if (/x-api-key|api key|authentication_error|invalid_api_key|incorrect api key|unauthorized.*(anthropic|openai)/.test(text)) {
    return 'model_provider_auth';
  }
  if (/rate.?limit|\b429\b|overloaded/.test(text)) return 'model_rate_limit';
  if (/structured result|did not submit|submit_|valibot|schema validation|invalid.*output/.test(text))
    return 'invalid_model_output';
  // `github_access` covers the source control API whichever it is (GitHub, Azure DevOps, Bitbucket), so the category
  // stays comparable across runs.
  if (
    status === 401 ||
    status === 403 ||
    status === 404 ||
    /github|octokit|bad credentials|resource not accessible|azure devops|tf\d{6}|bitbucket/.test(text)
  ) {
    return 'github_access';
  }
  if (/timed? ?out|timeout|aborterror|etimedout/.test(text)) return 'timeout';
  return 'unknown';
}

// The outcome of a single breaking-changes run. Like PrReviewOutcome, each value maps to one of the
// exit points in the breaking-changes workflow.
export type BreakingChangesOutcome =
  | 'breaking_changes_reported'
  | 'no_breaking_changes'
  | 'no_schema_changes'
  | 'no_changed_files'
  | 'no_pull_request'
  | 'closed_without_merge'
  | 'error';

// The outcome of a single ADR Compliance run. Each value maps to one exit point in its workflow.
export type AdrComplianceOutcome =
  | 'conflicts_reported'
  | 'only_exceptions'
  | 'no_conflicts'
  | 'no_relevant_adrs'
  | 'no_accepted_adrs'
  | 'no_changed_files'
  | 'no_pull_request'
  | 'closed_without_merge'
  | 'error';

/** `trigger` is what started the run: an open pull request, or a merged one. */
type RunContext = { model?: string; durationMs: number; trigger: 'pull_request' | 'merged' };

// posthog-node batches and sends in the background, so a short-lived CI process must flush before
// it exits or events are lost. We create the client lazily and `shutdown()` it in the same call,
// which is the simplest correct shape for a one-shot run. Analytics must never break a run, so
// everything is wrapped and swallowed. The only properties we ever send are the high-level outcome,
// the error category, the model, the run duration, the trigger, the repository, the CI system, and counts of the agent's own
// catalog pull requests — never anything about the contents of the repo.
/** Where the run happened: the CI system, never anything about the repository's contents. */
const ciSystem = (): 'github-actions' | 'azure-pipelines' | 'bitbucket-pipelines' | 'other' => {
  if (process.env.GITHUB_ACTIONS === 'true') return 'github-actions';
  if (isAzurePipelines(process.env)) return 'azure-pipelines';
  return isBitbucketPipelines(process.env) ? 'bitbucket-pipelines' : 'other';
};

/**
 * The repository's name, as `owner/repo` on GitHub, `workspace/repo` on Bitbucket (the same shape), or
 * `project/repo` in Azure DevOps. The Azure DevOps organization is left out on purpose, to send less that
 * identifies the user, even though `project/repo` isn't unique across organizations.
 */
const repositoryName = (): string | undefined =>
  process.env.GITHUB_REPOSITORY ||
  (process.env.SYSTEM_TEAMPROJECT && process.env.BUILD_REPOSITORY_NAME
    ? `${process.env.SYSTEM_TEAMPROJECT}/${process.env.BUILD_REPOSITORY_NAME}`
    : undefined) ||
  (isBitbucketPipelines(process.env) ? process.env.BITBUCKET_REPO_FULL_NAME : undefined);

async function capture(event: string, outcome: string, context: RunContext, extra: Record<string, unknown> = {}) {
  if (!ENABLED) return;

  const client = new PostHog(POSTHOG_KEY as string, { host: POSTHOG_HOST });

  try {
    client.capture({
      // CI runs have no user; group by repo so runs aggregate per project.
      distinctId: repositoryName() || 'eventcatalog-action',
      event,
      properties: {
        outcome,
        model: context.model,
        duration_ms: context.durationMs,
        trigger: context.trigger,
        repository: repositoryName(),
        ci: ciSystem(),
        ...extra,
      },
    });
    await client.shutdown();
  } catch {
    // Swallow everything — analytics is best-effort.
  }
}

/** Counts of the agent's catalog pull requests by state, as analytics properties. Best effort. */
async function agentPullRequestProperties(config: ReviewConfig): Promise<Record<string, number>> {
  if (!ENABLED) return {};
  try {
    const stats = await getAgentPullRequestStats(config);
    return stats
      ? {
          agent_prs_open: stats.open,
          agent_prs_merged_30d: stats.merged30d,
          agent_prs_closed_unmerged_30d: stats.closedUnmerged30d,
        }
      : {};
  } catch {
    return {};
  }
}

// Record a completed PR-review run. Pass the workflow result and we work out the outcome from it.
export async function trackPrReviewCompleted(config: ReviewConfig, result: PrReviewResult, context: RunContext) {
  return capture('pr_review_completed', outcomeFromResult(result), context, await agentPullRequestProperties(config));
}

// Record a PR-review run that threw before producing a result.
export async function trackPrReviewError(config: ReviewConfig, error: unknown, context: RunContext) {
  return capture('pr_review_completed', 'error', context, {
    error_type: classifyError(error),
    ...(await agentPullRequestProperties(config)),
  });
}

// Record a completed breaking-changes run. The workflow labels its own outcome because, unlike
// pr-review, its exit points are not distinguishable from the returned result shape alone.
export function trackBreakingChangesCompleted(outcome: BreakingChangesOutcome, context: RunContext) {
  return capture('breaking_changes_completed', outcome, context);
}

// Record a breaking-changes run that threw before producing a result.
export function trackBreakingChangesError(error: unknown, context: RunContext) {
  return capture('breaking_changes_completed', 'error', context, { error_type: classifyError(error) });
}

// Record a completed ADR Compliance run. Like breaking-changes, the workflow labels its own outcome.
export function trackAdrComplianceCompleted(outcome: AdrComplianceOutcome, context: RunContext) {
  return capture('adr_compliance_completed', outcome, context);
}

// Record an ADR Compliance run that threw before producing a result.
export function trackAdrComplianceError(error: unknown, context: RunContext) {
  return capture('adr_compliance_completed', 'error', context, { error_type: classifyError(error) });
}
