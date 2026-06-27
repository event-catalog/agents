/**
 * Decides which changed files in a pull request look like message schemas (JSON Schema, Avro,
 * Protobuf, GraphQL, OpenAPI/AsyncAPI, etc). The breaking-changes workflow only ever inspects
 * these files, so this is the gate that keeps the agent focused on schema diffs instead of every
 * source change in the pull request.
 */

/**
 * Default file extensions we treat as message schemas, matched case-insensitively against the file
 * name. The `schema-extensions` action input defaults to this same list in `action.yml` (keep the
 * two in sync); this constant is the fallback for non-Action callers (evals, local runs). Users can
 * override it to, for example, add `.js` when their contracts live in source files.
 */
export const DEFAULT_SCHEMA_EXTENSIONS = ['.json', '.yml', '.yaml', '.avro', '.avsc', '.proto', '.graphql', '.gql'];

/** A changed file as handed to the workflow (matches the `changedFiles` shape built in the workflow). */
export type ChangedFileSummary = {
  changedLines: unknown;
  diff: string;
  fileName: string;
};

const hasSchemaExtension = (fileName: string, extensions: string[]): boolean => {
  const lower = fileName.toLowerCase();
  return extensions.some((extension) => lower.endsWith(extension.toLowerCase()));
};

/**
 * Returns the changed files that look like message schemas. We match on extension only; the agent
 * is responsible for the harder judgement of whether the change is actually breaking. Pass
 * `extensions` to override the {@link DEFAULT_SCHEMA_EXTENSIONS}.
 */
export const getChangedSchemaFiles = <T extends ChangedFileSummary>(
  changedFiles: T[],
  extensions: string[] = DEFAULT_SCHEMA_EXTENSIONS
): T[] => changedFiles.filter((file) => hasSchemaExtension(file.fileName, extensions));
