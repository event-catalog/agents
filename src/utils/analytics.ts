import { PostHog } from 'posthog-node';
import { MISSING_CATALOG_MESSAGE } from '@/src/utils/eventcatalog-utils';

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
  | 'error';

// The shape of whatever the workflow returned. We only read the few fields that tell us the
// outcome, so this stays loose on purpose and the workflow keeps returning its normal result.
// We deliberately do NOT read anything about the contents of a user's repo (file counts, paths,
// diffs) — only the high-level outcome of the run.
type PrReviewResult = {
  message?: string;
  catalogPullRequest?: unknown;
  unauthorizedCatalogChanges?: unknown;
};

// Derive the analytics outcome from a workflow result by its structure, so the workflow body
// never has to label its own exit points for analytics.
function outcomeFromResult(result: PrReviewResult): PrReviewOutcome {
  if (result.catalogPullRequest) return 'catalog_pr_created';
  if (result.unauthorizedCatalogChanges) return 'unauthorized_changes_blocked';
  if (result.message === MISSING_CATALOG_MESSAGE) return 'catalog_missing';
  if (result.message?.startsWith('EventCatalog action skipped:')) return 'access_denied';
  if (result.message === 'No changed files found') return 'no_changed_files';
  return 'no_changes_required';
}

// posthog-node batches and sends in the background, so a short-lived CI process must flush before
// it exits or events are lost. We create the client lazily and `shutdown()` it in the same call,
// which is the simplest correct shape for a one-shot run. Analytics must never break a review, so
// everything is wrapped and swallowed.
async function capture(outcome: PrReviewOutcome, context: { model?: string; durationMs: number }) {
  if (!ENABLED) return;

  const client = new PostHog(POSTHOG_KEY as string, { host: POSTHOG_HOST });

  try {
    client.capture({
      // CI runs have no user; group by repo so runs aggregate per project.
      distinctId: process.env.GITHUB_REPOSITORY || 'eventcatalog-action',
      event: 'pr_review_completed',
      properties: {
        outcome,
        model: context.model,
        duration_ms: context.durationMs,
        repository: process.env.GITHUB_REPOSITORY,
      },
    });
    await client.shutdown();
  } catch {
    // Swallow everything — analytics is best-effort.
  }
}

// Record a completed PR-review run. Pass the workflow result and we work out the outcome from it.
export function trackPrReviewCompleted(result: PrReviewResult, context: { model?: string; durationMs: number }) {
  return capture(outcomeFromResult(result), context);
}

// Record a PR-review run that threw before producing a result.
export function trackPrReviewError(context: { model?: string; durationMs: number }) {
  return capture('error', context);
}
