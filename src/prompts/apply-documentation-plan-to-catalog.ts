import type { FlueSession } from '@flue/runtime';
import { promptResponse, type ImpactPlanResponse, type PromptResponse } from '@/src/review-output';
import type { ChangedFile } from '@/src/review-types';

/**
 * Tells the agent to apply an approved documentation plan, editing only the catalog files under the
 * approved target paths and returning a catalog PR title and summary.
 *
 * This file is the single source of truth for this prompt — both the production workflow
 * (`src/workflows/pr-review.ts`) and the evals (`evals/support/harness.ts`) use it. Edit the prompt
 * wording in `buildApplyDocumentationPlanPrompt`.
 */
export const buildApplyDocumentationPlanPrompt = (
  impactPlan: ImpactPlanResponse,
  changedFiles: ChangedFile[],
  catalogPath: string
): string =>
  'Apply this approved EventCatalog documentation update plan:\n\n' +
  JSON.stringify(impactPlan, null, 2) +
  '\n\nSource pull request changes:\n\n' +
  JSON.stringify(changedFiles, null, 2) +
  `\n\nYou may only edit catalog files under these approved target paths:
${impactPlan.proposedCatalogTargets.map((target) => `- ${target.path}: ${target.reason}`).join('\n')}

Use the \`dump_catalog\` tool if needed to locate existing resources. Update the documentation in the eventcatalog directory (${catalogPath}) only for the approved targets. If the approved plan is insufficient, do not improvise unrelated catalog changes; explain that limitation in the structured response. Use the \`linter\` tool after making catalog changes. When finished, return structured output with a descriptive catalog PR title, a catalog PR summary explaining what changed and why, and a concise high-level source PR summary.`;

/** Applies the approved plan, editing catalog files under the approved targets. */
export const applyDocumentationPlan = async (
  session: FlueSession,
  impactPlan: ImpactPlanResponse,
  changedFiles: ChangedFile[],
  catalogPath: string
): Promise<PromptResponse> => {
  const response = await session.prompt(buildApplyDocumentationPlanPrompt(impactPlan, changedFiles, catalogPath), {
    result: promptResponse,
  });

  return response.data;
};
