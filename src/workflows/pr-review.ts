import type { FlueContext } from '@flue/runtime';
import codeToDocsAgent from '@/src/agents/code-to-docs';
import { resolveConfig, type ReviewPayload } from '@/src/config';
import { createOrUpdateCatalogPullRequest, preflightCatalogPullRequestAccess } from '@/src/utils/github/catalog-pr';
import { postPullRequestSummary } from '@/src/utils/github/reporter';
import { applyDocumentationPlan } from '@/src/prompts/apply-documentation-plan-to-catalog';
import { createDocumentationPlan } from '@/src/prompts/create-documentation-plan-from-code-changes';
import {
  createMissingCatalogResult,
  doesCatalogExist,
  getChangedCatalogFiles,
  resolveCatalogPath,
} from '@/src/utils/eventcatalog-utils';
import { getChangedFiles } from '@/src/utils/diff';
import { getUnauthorizedCatalogChanges } from '@/src/utils/impact-plan';
import { trackPrReviewCompleted, trackPrReviewError } from '@/src/utils/analytics';

export async function run(context: FlueContext<ReviewPayload>) {
  const startedAt = Date.now();
  const config = resolveConfig(context.payload, context.env as NodeJS.ProcessEnv);

  try {
    const result = await review(context, config);
    await trackPrReviewCompleted(result, { model: config.model, durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    await trackPrReviewError({ model: config.model, durationMs: Date.now() - startedAt });
    throw error;
  }
}

async function review({ init, payload }: FlueContext<ReviewPayload>, config: ReturnType<typeof resolveConfig>) {
  console.error('[eventcatalog:flue] PR review workflow started');

  // First we check if the catalog exists and can be found.
  if (!(await doesCatalogExist(config))) {
    const result = createMissingCatalogResult(config);
    await postPullRequestSummary(config, { catalogPath: config.catalogPath, changedFiles: [], result });
    return result;
  }

  // Check if we can actually access the catalog repo and branch before we do any work.
  try {
    await preflightCatalogPullRequestAccess(config);
  } catch (error) {
    const result = {
      catalogPath: config.catalogPath,
      message: `EventCatalog action skipped: ${error instanceof Error ? error.message : String(error)}`,
      reviewed: 0,
      skipped: true,
    };
    await postPullRequestSummary(config, { catalogPath: config.catalogPath, changedFiles: [], result });
    return result;
  }

  const harness = await init(codeToDocsAgent, {});
  const session = await harness.session();

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
    await postPullRequestSummary(config, { catalogPath: config.catalogPath, changedFiles: [], result });
    return result;
  }

  const catalogPath = resolveCatalogPath(config);

  // First we create the documentation plan, analyse the diff and figure out what needs to change/create.
  // The planning step is read-only (see the prompt); we no longer discard between phases, so any work
  // the agent does survives into the applied result instead of being wiped and silently no-op'd.
  const { impactPlan, shouldApply } = await createDocumentationPlan(session, changedFiles, config.catalogPath);

  console.error(
    `[eventcatalog:flue] Impact plan created: ${impactPlan.catalogChangesRequired ? 'catalog changes required' : 'no catalog changes required'}`
  );

  if (!shouldApply) {
    const result = {
      catalogPath: config.catalogPath,
      impactPlan,
      message: 'No EventCatalog documentation changes are required for this pull request.',
      reviewed: changedFiles.length,
      skipped: true,
      sourcePrSummary: impactPlan.sourcePrSummary,
    };

    await postPullRequestSummary(config, {
      catalogPath: config.catalogPath,
      changedFiles: changedFiles.map((file) => file.fileName),
      result,
    });

    return result;
  }

  // Next, tell the agent to apply the documentation plan on EventCatalog project
  const reviewResult = await applyDocumentationPlan(session, impactPlan, changedFiles, config.catalogPath);
  const catalogChangedFiles = await getChangedCatalogFiles(catalogPath);
  const unauthorizedCatalogChanges = getUnauthorizedCatalogChanges(catalogChangedFiles, impactPlan, config.catalogPath);

  if (unauthorizedCatalogChanges.length > 0) {
    const result = {
      catalogPath: config.catalogPath,
      impactPlan,
      message: 'EventCatalog action skipped because the agent changed files outside the approved impact plan.',
      reviewed: changedFiles.length,
      skipped: true,
      unauthorizedCatalogChanges,
    };

    await postPullRequestSummary(config, {
      catalogPath: config.catalogPath,
      changedFiles: changedFiles.map((file) => file.fileName),
      result,
    });

    return result;
  }

  // Changes have been made, so update the catalog through a pull request.
  const catalogPullRequest = await createOrUpdateCatalogPullRequest(config, {
    result: reviewResult,
  });

  // Tell the user what has changed in  a summary on this pull request.
  await postPullRequestSummary(config, {
    catalogPath: config.catalogPath,
    catalogPullRequestUrl: catalogPullRequest.pullRequestUrl,
    changedFiles: changedFiles.map((file) => file.fileName),
    result: reviewResult,
  });

  return { catalogPullRequest, response: reviewResult };
}
