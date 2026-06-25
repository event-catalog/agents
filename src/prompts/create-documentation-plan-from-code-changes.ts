import type { FlueSession } from '@flue/runtime';
import { impactPlanResponse, SOURCE_CHANGE_TYPES, type ImpactPlanResponse } from '@/src/review-output';
import type { ChangedFile } from '@/src/review-types';

/**
 * Asks the agent to inspect the source diff and catalog and return a structured plan of which
 * EventCatalog documentation needs to change, without editing any files.
 *
 * This file is the single source of truth for this prompt — both the production workflow
 * (`src/workflows/pr-review.ts`) and the evals (`evals/support/harness.ts`) use it. Edit the prompt
 * wording in `buildDocumentationPlanPrompt`.
 */
export const buildDocumentationPlanPrompt = (changedFiles: ChangedFile[], catalogPath: string): string =>
  'Here are the source file changes for this pull request:\n\n' +
  JSON.stringify(changedFiles, null, 2) +
  `\n\nThis is a READ-ONLY planning step. Use your read, grep, glob, and dump_catalog tools to understand the code changes and inspect the EventCatalog directory (${catalogPath}). You MUST NOT create, edit, write, or delete ANY files in this step — do not use write or edit tools at all. You are only producing a plan; a later step applies it. If you feel tempted to write a file now, instead describe it as a proposed catalog target.

Return a structured impact plan:
- Identify only source changes introduced or modified by this pull request.
- Classify each source change with one of these exact types: ${SOURCE_CHANGE_TYPES.join(', ')}.
  When an existing event/command/query's payload or schema changes (e.g. a field is added to its
  published message), classify it as schema-changed — not event-added or service-changed.
- Decide whether those changes require EventCatalog documentation updates.
- List the exact catalog resource folders or files that are justified by the source diff.
- Put unrelated catalog inconsistencies in outOfScopeFindings instead of proposedCatalogTargets.`;

/** The structured documentation plan, plus whether any catalog changes need to be applied. */
export type DocumentationPlanResult = {
  impactPlan: ImpactPlanResponse;
  /** True when the agent found catalog changes are required and proposed at least one target. */
  shouldApply: boolean;
};

/** Prompts the agent for a structured documentation plan. Does not edit files. */
export const createDocumentationPlan = async (
  session: FlueSession,
  changedFiles: ChangedFile[],
  catalogPath: string
): Promise<DocumentationPlanResult> => {
  const planResponse = await session.prompt(buildDocumentationPlanPrompt(changedFiles, catalogPath), {
    result: impactPlanResponse,
  });
  const impactPlan = planResponse.data;

  return {
    impactPlan,
    shouldApply: impactPlan.catalogChangesRequired && impactPlan.proposedCatalogTargets.length > 0,
  };
};
