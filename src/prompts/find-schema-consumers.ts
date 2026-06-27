import type { FlueSession } from '@flue/runtime';
import { schemaConsumersResponse, type BreakingChangeResponse, type SchemaConsumersResponse } from '@/src/review-output';

/**
 * Asks the agent to trace a breaking schema change to its consumers in the EventCatalog. The agent
 * first resolves which catalog resource the schema belongs to (a message, service, or domain), then
 * finds anything that receives or implements that message. This is a read-only step.
 *
 * This file is the single source of truth for the prompt wording. Edit it in
 * `buildFindSchemaConsumersPrompt`.
 */
export const buildFindSchemaConsumersPrompt = (breakingChange: BreakingChangeResponse, catalogPath: string): string =>
  'A breaking schema change was detected in this pull request:\n\n' +
  JSON.stringify(breakingChange, null, 2) +
  `\n\nThis is a READ-ONLY analysis step. You MUST NOT create, edit, write, or delete any files.

Use the \`dump_catalog\` tool to get an index of the EventCatalog (${catalogPath}), then use your read, grep, and glob tools to trace this schema to the resources that depend on it.

1. Resolve which catalog resource this schema belongs to. The schema file is usually attached to a message (event, command, or query), but may belong to a service or domain.
2. If you can find the resource (e.g message/service/domain) the schema belong too, then you have the resource id and version in the markdown file.
3. With the resource id and version of the owner of the schema, you can grep and understand who is consuming this resouce. For example a service is a consumer if it "recieves" (in the frontmatter property) this schema resource (e.g OrderPlaced Event)
4. A resource (E.g service) that sends the message is the producer, not a consumer; focus on consumers that could break.
5. Return each affected consumer with its id, version, type, path relative to the catalog root, and a short reason explaining why it is affected.

If you cannot resolve the schema to a catalog resource, or it has no consumers, return an empty consumers array. Do not invent resources; only report consumers you can find in the catalog.`;

/** Finds the catalog consumers of a breaking schema change. Does not edit files. */
export const findSchemaConsumers = async (
  session: FlueSession,
  breakingChange: BreakingChangeResponse,
  catalogPath: string
): Promise<SchemaConsumersResponse> => {
  const response = await session.prompt(buildFindSchemaConsumersPrompt(breakingChange, catalogPath), {
    result: schemaConsumersResponse,
  });

  return response.data;
};
