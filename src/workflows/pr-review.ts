import { CodeToDocs } from '@/src/agents/code-to-docs';
import { initWithData } from '@/src/agents/structured-results';
import { CLOSED_WITHOUT_MERGE_MESSAGE, resolveConfig, runTrigger, type ReviewConfig, type ReviewPayload } from '@/src/config';
import { createOrUpdateCatalogPullRequest, preflightCatalogPullRequestAccess } from '@/src/utils/pull-requests/catalog-pr';
import { postPullRequestSummary } from '@/src/utils/pull-requests/reporter';
import { applyDocumentationPlan } from '@/src/prompts/apply-documentation-plan-to-catalog';
import { createDocumentationPlan } from '@/src/prompts/create-documentation-plan-from-code-changes';
import { archivePreviousVersions } from '@/src/utils/archive-versions';
import {
  createMissingCatalogResult,
  doesCatalogExist,
  getChangedCatalogFiles,
  resolveCatalogPath,
} from '@/src/utils/eventcatalog-utils';
import { getChangedFiles } from '@/src/utils/diff';
import { catalogAccessNextStep, describeSettings, resolvePullRequestContext } from '@/src/providers';
import { getUnauthorizedCatalogChanges } from '@/src/utils/impact-plan';
import { withVersionPinTargets } from '@/src/utils/version-pins';
import { trackPrReviewCompleted, trackPrReviewError } from '@/src/utils/analytics';

/**
 * The Code-to-Docs workflow. Expects a running Flue runtime (`start()` in `src/run.ts`, or the eval
 * harness) with the `CodeToDocs` agent registered.
 */
export async function run(payload: ReviewPayload | undefined, env: NodeJS.ProcessEnv = process.env) {
  const startedAt = Date.now();
  let config = resolveConfig(payload, env);

  try {
    config = await resolvePullRequestContext(config);
    const result = await review(payload, config);
    await trackPrReviewCompleted(config, result, {
      model: config.model,
      durationMs: Date.now() - startedAt,
      trigger: runTrigger(config),
    });
    return result;
  } catch (error) {
    await trackPrReviewError(config, error, {
      model: config.model,
      durationMs: Date.now() - startedAt,
      trigger: runTrigger(config),
    });
    throw error;
  }
}

async function review(payload: ReviewPayload | undefined, config: ReviewConfig) {
  console.error('[eventcatalog:flue] PR review workflow started');

  // A workflow that runs on merge triggers on every closed PR; a PR closed without merging has nothing
  // to document. Skip it quietly, without a comment, in case the workflow has no `if: merged` guard.
  // A run with no pull request (e.g. an Azure Pipelines build of a direct push) has nothing to document.
  if (config.skipReason) {
    console.error(`[eventcatalog:flue] ${config.skipReason}`);
    return { message: config.skipReason, noPullRequest: true, reviewed: 0, skipped: true };
  }

  if (config.pullRequestState === 'closed') {
    console.error(`[eventcatalog:flue] ${CLOSED_WITHOUT_MERGE_MESSAGE}`);
    return { message: CLOSED_WITHOUT_MERGE_MESSAGE, reviewed: 0, skipped: true };
  }

  // First we check if the catalog exists and can be found.
  if (!(await doesCatalogExist(config))) {
    const result = createMissingCatalogResult(config);
    await postPullRequestSummary(config, {
      kind: 'not-run',
      reason: `No EventCatalog project was found in ${config.catalogRepo ?? 'the catalog repository'} at \`${config.catalogRef}\`: ${result.message}.`,
      nextStep: `Check that the ${describeSettings(config, ['catalog-repo', 'catalog-ref'])} point at your EventCatalog project.`,
    });
    return result;
  }

  // Check if we can actually access the catalog repo and branch before we do any work.
  try {
    await preflightCatalogPullRequestAccess(config);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const result = {
      catalogPath: config.catalogPath,
      message: `EventCatalog agent skipped: ${reason}`,
      reviewed: 0,
      skipped: true,
    };
    await postPullRequestSummary(config, {
      kind: 'not-run',
      reason: `The agent couldn't access the catalog repository: ${reason}`,
      nextStep: catalogAccessNextStep(config),
    });
    return result;
  }

  const agent = initWithData(CodeToDocs, payload);

  // Get the changed files in the pull request
  const { files } = await getChangedFiles(config);
  const changedFiles = files.map((file) => ({
    changedLines: file.changedLines,
    diff: file.diff,
    fileName: file.relativePath,
  }));

  // If no files remain after diff filtering, we can exit early.
  if (changedFiles.length === 0) {
    const result = { catalogPagesChanges: 0, reviewed: 0, message: 'No changed files found' };
    await postPullRequestSummary(config, {
      kind: 'not-run',
      reason: 'Every file this pull request changes is in an ignored path, so there was nothing to review.',
      nextStep: `None. If some of these files should be reviewed, change the ${describeSettings(config, ['ignore-paths'])}.`,
    });
    return result;
  }

  const catalogPath = resolveCatalogPath(config);

  // First we create the documentation plan, analyse the diff and figure out what needs to change/create.
  // The planning step is read-only (see the prompt); we no longer discard between phases, so any work
  // the agent does survives into the applied result instead of being wiped and silently no-op'd.
  const plan = await createDocumentationPlan(agent, changedFiles, config.catalogPath);
  const { shouldApply } = plan;

  console.error(
    `[eventcatalog:flue] Impact plan created: ${plan.impactPlan.catalogChangesRequired ? 'catalog changes required' : 'no catalog changes required'}`
  );

  if (!shouldApply) {
    const result = {
      catalogPath: config.catalogPath,
      impactPlan: plan.impactPlan,
      message: 'No EventCatalog documentation changes are required for this pull request.',
      reviewed: changedFiles.length,
      skipped: true,
      sourcePrSummary: plan.impactPlan.sourcePrSummary,
    };

    await postPullRequestSummary(config, { kind: 'no-changes', impactPlan: plan.impactPlan, reviewedFiles: changedFiles.length });
    return result;
  }

  // If the agent bumps a planned message's version, the resources that pin that version must change
  // too. Add them to the plan from the catalog rather than relying on the model to find them all.
  const impactPlan = await withVersionPinTargets(plan.impactPlan, catalogPath, config.catalogPath);

  // Next, tell the agent to apply the documentation plan on EventCatalog project
  const reviewResult = await applyDocumentationPlan(agent, impactPlan, changedFiles, config.catalogPath);
  // Keep the previous version of anything the agent re-versioned, as EventCatalog expects. The tools
  // usually did this already; the off-plan check accepts these archive folders.
  const archivedVersions = await archivePreviousVersions(catalogPath);
  const catalogChangedFiles = await getChangedCatalogFiles(catalogPath);
  const unauthorizedCatalogChanges = getUnauthorizedCatalogChanges(
    catalogChangedFiles,
    impactPlan,
    config.catalogPath,
    archivedVersions
  );

  if (unauthorizedCatalogChanges.length > 0) {
    const result = {
      catalogPath: config.catalogPath,
      impactPlan,
      message: 'EventCatalog agent skipped because the agent changed files outside the approved impact plan.',
      reviewed: changedFiles.length,
      skipped: true,
      unauthorizedCatalogChanges,
    };

    await postPullRequestSummary(config, {
      kind: 'off-plan',
      impactPlan,
      unauthorizedChanges: unauthorizedCatalogChanges,
      reviewedFiles: changedFiles.length,
    });
    return result;
  }

  // Changes have been made, so update the catalog through a pull request.
  const catalogPullRequest = await createOrUpdateCatalogPullRequest(config, { impactPlan, result: reviewResult });

  // Tell the user what has changed in a comment on this pull request.
  if (catalogPullRequest.changes.length === 0) {
    await postPullRequestSummary(config, {
      kind: 'no-changes',
      impactPlan,
      reviewedFiles: changedFiles.length,
      note: 'The agent planned catalog changes but did not end up making any, so no catalog pull request was opened.',
    });
  } else {
    await postPullRequestSummary(config, {
      kind: 'catalog-updated',
      catalogPullRequestUrl: catalogPullRequest.pullRequestUrl,
      changes: catalogPullRequest.changes,
      impactPlan,
      reviewedFiles: changedFiles.length,
    });
  }

  return { archivedVersions, catalogPullRequest, response: reviewResult };
}
