import type { FlueSession } from '@flue/runtime';
import { breakingChangeResponse, type BreakingChangeResponse } from '@/src/review-output';
import type { ChangedFile } from '@/src/review-types';

/**
 * Asks the agent to inspect a single changed schema diff and score whether the change is breaking
 * for existing consumers. This is a read-only step; it only reasons about the diff and never edits
 * any files.
 *
 * Like the documentation-plan prompts, this file is the single source of truth for the prompt
 * wording. Edit the prompt in `buildDetectBreakingSchemaChangePrompt`.
 */
export const buildDetectBreakingSchemaChangePrompt = (schemaFile: ChangedFile): string =>
  'Here is a changed schema file from this pull request:\n\n' +
  JSON.stringify(schemaFile, null, 2) +
  `\n\nThis is a READ-ONLY analysis step. You MUST NOT create, edit, write, or delete any files. Use your read, grep, and glob tools only if you need surrounding context.

Decide whether this schema change is a breaking change for existing consumers. Treat these as breaking:
- Removing or renaming a field, property, message, or enum value.
- Changing the type of an existing field (for example string to number).
- Adding a new required field, or making an optional field required.
- Narrowing a value (tightening an enum, range, or format) so previously valid payloads become invalid.
- Removing or restructuring a message in a way that changes its contract.

Treat these as non-breaking (additive):
- Adding a new optional field.
- Adding a new enum value to an open enum.
- Documentation, description, or comment changes only.

Return a structured result for THIS file:
- Set isBreaking and a confidence level.
- For each breaking change, copy the exact diff line(s) that introduce it so they can be highlighted in the pull request.
- Keep the summary concise and written for the pull request author.`;

/** Scores a single changed schema file for breaking changes. Does not edit files. */
export const detectBreakingSchemaChange = async (
  session: FlueSession,
  schemaFile: ChangedFile
): Promise<BreakingChangeResponse> => {
  const response = await session.prompt(buildDetectBreakingSchemaChangePrompt(schemaFile), {
    result: breakingChangeResponse,
  });

  return response.data;
};
