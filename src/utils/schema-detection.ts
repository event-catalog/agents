/**
 * Decides which changed files in a pull request look like message schemas (JSON Schema, Avro,
 * Protobuf, GraphQL, OpenAPI/AsyncAPI, etc). The breaking-changes workflow only ever inspects
 * these files, so this is the gate that keeps the agent focused on schema diffs instead of every
 * source change in the pull request.
 */

/** File extensions we treat as message schemas. Matched case-insensitively against the file name. */
const SCHEMA_EXTENSIONS = ['.json', '.yml', '.yaml', '.avro', '.avsc', '.proto', '.graphql', '.gql'] as const;

/** A changed file as handed to the workflow (matches the `changedFiles` shape built in the workflow). */
export type ChangedFileSummary = {
  changedLines: unknown;
  diff: string;
  fileName: string;
};

const hasSchemaExtension = (fileName: string): boolean => {
  const lower = fileName.toLowerCase();
  return SCHEMA_EXTENSIONS.some((extension) => lower.endsWith(extension));
};

/**
 * Returns the changed files that look like message schemas. We match on extension only; the agent
 * is responsible for the harder judgement of whether the change is actually breaking.
 */
export const getChangedSchemaFiles = <T extends ChangedFileSummary>(changedFiles: T[]): T[] =>
  changedFiles.filter((file) => hasSchemaExtension(file.fileName));
