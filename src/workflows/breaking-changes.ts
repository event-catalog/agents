import type { FlueContext } from '@flue/runtime';
import breakingChangesAgent from '@/src/agents/breaking-changes';
import { resolveConfig, type ReviewConfig, type ReviewPayload } from '@/src/config';
import { postBreakingChangesSummary, type BreakingSchemaReport } from '@/src/utils/github/reporter';
import { detectBreakingSchemaChange } from '@/src/prompts/detect-breaking-schema-changes';
import { findSchemaConsumers } from '@/src/prompts/find-schema-consumers';
import { resolveCatalogPath } from '@/src/utils/eventcatalog-utils';
import { getChangedFiles } from '@/src/utils/diff';
import { getChangedSchemaFiles } from '@/src/utils/schema-detection';
import { trackBreakingChangesCompleted, trackBreakingChangesError, type BreakingChangesOutcome } from '@/src/utils/analytics';

/** The result of a breaking-changes run, plus the outcome we report to analytics. */
type BreakingChangesResult = {
  outcome: BreakingChangesOutcome;
  reports: BreakingSchemaReport[];
};

export async function run(context: FlueContext<ReviewPayload>) {
  const startedAt = Date.now();
  const config = resolveConfig(context.payload, context.env as NodeJS.ProcessEnv);

  try {
    const { outcome, reports } = await review(context, config);
    await trackBreakingChangesCompleted(outcome, { model: config.model, durationMs: Date.now() - startedAt });
    return { outcome, reports };
  } catch (error) {
    await trackBreakingChangesError({ model: config.model, durationMs: Date.now() - startedAt });
    throw error;
  }
}

async function review({ init }: FlueContext<ReviewPayload>, config: ReviewConfig): Promise<BreakingChangesResult> {
  console.error('[eventcatalog:flue] Breaking Changes Agent workflow started');

  // Get the changed files in the pull request.
  const { files } = await getChangedFiles(config);
  const changedFiles = files.map((file) => ({
    changedLines: file.changedLines,
    diff: file.diff,
    fileName: file.relativePath,
  }));

  // If no files remain after diff filtering, we can exit early.
  if (changedFiles.length === 0) {
    console.error('[eventcatalog:flue] No changed files found; nothing to check for breaking changes');
    return { outcome: 'no_changed_files', reports: [] };
  }

  // 1. Narrow to schema-like files (json, yml, avro, proto, graphql, and similar). The agent only
  //    ever reasons about these; non-schema source changes are out of scope for this workflow.
  const schemaFiles = getChangedSchemaFiles(changedFiles, config.schemaExtensions);

  if (schemaFiles.length === 0) {
    console.error('[eventcatalog:flue] No schema changes detected in this pull request');
    return { outcome: 'no_schema_changes', reports: [] };
  }

  console.error(`[eventcatalog:flue] Found ${schemaFiles.length} changed schema file(s); scoring for breaking changes`);

  const harness = await init(breakingChangesAgent, {});
  const session = await harness.session();
  const catalogPath = resolveCatalogPath(config);

  // 2. Score each changed schema for breaking changes (read-only). Anything that is not breaking is
  //    dropped here so we never go looking for consumers of an additive change.
  const breakingChanges = [];
  for (const schemaFile of schemaFiles) {
    const breakingChange = await detectBreakingSchemaChange(session, schemaFile);
    console.error(
      `[eventcatalog:flue] ${schemaFile.fileName}: ${breakingChange.isBreaking ? `breaking (${breakingChange.confidence} confidence)` : 'not breaking'}`
    );

    if (breakingChange.isBreaking) {
      breakingChanges.push(breakingChange);
    }
  }

  if (breakingChanges.length === 0) {
    console.error('[eventcatalog:flue] No breaking schema changes found');
    return { outcome: 'no_breaking_changes', reports: [] };
  }

  // 3. For each breaking change, trace the schema to the catalog resources that consume it (read-only).
  const reports: BreakingSchemaReport[] = [];
  for (const breakingChange of breakingChanges) {
    const { consumers, diagram } = await findSchemaConsumers(session, breakingChange, catalogPath);
    console.error(`[eventcatalog:flue] ${breakingChange.fileName}: found ${consumers.length} affected consumer(s)`);
    reports.push({ breakingChange, consumers, diagram });
  }

  // 4. Report the breaking changes and any affected consumers back on the source pull request.
  await postBreakingChangesSummary(config, reports);

  return { outcome: 'breaking_changes_reported', reports };
}
