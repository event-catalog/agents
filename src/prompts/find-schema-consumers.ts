import type { AgentInstanceHandle } from '@flue/runtime';
import { promptForResult } from '@/src/agents/structured-results';
import { schemaConsumersResult, type BreakingChangeResponse, type SchemaConsumersResponse } from '@/src/review-output';

/**
 * Asks the agent to trace a breaking schema change to its consumers in the EventCatalog. The agent
 * first resolves which catalog resource the schema belongs to (a message, service, or domain), then
 * finds anything that receives or implements that message. This is a read-only step.
 *
 * This file is the single source of truth for the prompt wording. Edit it in
 * `buildFindSchemaConsumersPrompt`.
 */
export const buildFindSchemaConsumersPrompt = (
  breakingChange: BreakingChangeResponse,
  catalogPath: string,
  catalogUrl?: string
): string =>
  'A breaking schema change was detected in this pull request:\n\n' +
  JSON.stringify(breakingChange, null, 2) +
  `\n\nThis is a READ-ONLY analysis step. You MUST NOT create, edit, write, or delete any files.

Use the \`dump_catalog\` tool to get an index of the EventCatalog (${catalogPath}), then use your read, grep, and glob tools to trace this schema to the resources that depend on it.
${catalogUrl ? `\nThe hosted EventCatalog URL is ${catalogUrl}. Use this when reasoning about public catalog links, but still return structured resource ids, versions, owner ids, and paths exactly as requested below.\n` : ''}

1. Resolve which catalog resource this schema belongs to. The schema file is usually attached to a message (event, command, or query), but may belong to a service or domain.
2. Once you have found the resource the schema belongs to, read its id and version from its frontmatter.
3. Find the resources that consume it. A service, agent, or domain is a consumer if its \`receives\` frontmatter lists the resource's id. A \`receives\` entry matches when its version is the resource's current version, \`latest\`, missing (which means latest), or a range that includes it (e.g. \`1.x\`, \`^1.0.0\`). An entry pinned to an older exact version is still on that version: include it, and say so in the reason.
4. A resource (e.g. a service) that sends the message is the producer, not a consumer; focus on consumers that could break.
5. Return each affected consumer with its id, version, type, summary, owners, path relative to the catalog root, and a short reason explaining why it is affected. Base the reason only on what the catalog documents (for example "Receives payment-succeeded 1.0.0"). Don't guess how the consumer uses particular fields; the catalog rarely says, and a wrong guess misleads the reader.
6. Use the consumer summary and owners from the catalog front matter or the \`dump_catalog\` result. If a consumer has no summary, return an empty string. If it has no owners, return an empty owners array.
7. Return a useful Mermaid flowchart in \`diagram\`. The first non-empty line must be \`flowchart LR\`. Follow the Mermaid diagram conventions from your agent instructions. Use only real resource ids you found in the catalog. Use an empty string if you cannot resolve enough resources for a useful diagram.

If you cannot resolve the schema to a catalog resource, or it has no consumers, return an empty consumers array and an empty diagram. Do not invent resources; only report consumers you can find in the catalog.`;

/** Finds the catalog consumers of a breaking schema change. Does not edit files. */
export const findSchemaConsumers = async (
  agent: AgentInstanceHandle,
  breakingChange: BreakingChangeResponse,
  catalogPath: string,
  catalogUrl?: string
): Promise<SchemaConsumersResponse> => {
  return promptForResult(agent, buildFindSchemaConsumersPrompt(breakingChange, catalogPath, catalogUrl), schemaConsumersResult);
};
