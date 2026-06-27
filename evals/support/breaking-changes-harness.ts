import { execFile } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createHarness } from 'vitest-evals';
import { observe } from '@flue/runtime';
import { createFlueContext, InMemorySessionStore, resolveModel } from '@flue/runtime/internal';
import { local } from '@flue/runtime/node';
import breakingChangesAgent from '@/src/agents/breaking-changes';
import type { ReviewPayload } from '@/src/config';
import type { BreakingChangeResponse, SchemaConsumersResponse } from '@/src/review-output';
import { detectBreakingSchemaChange } from '@/src/prompts/detect-breaking-schema-changes';
import { findSchemaConsumers } from '@/src/prompts/find-schema-consumers';
import type { ChangedFile } from '@/src/review-types';
import { MODEL, type UsageTotals } from './harness';
import { getPackagedSkills } from './skill-registry';

const exec = promisify(execFile);
const git = (cwd: string, args: string[]) => exec('git', args, { cwd, maxBuffer: 1024 * 1024 * 20 });

/**
 * One breaking-changes eval scenario. Like the code-to-docs harness, each scenario runs the REAL
 * breaking-changes prompts (real model, the `dump_catalog` tool, the skill) against a fixture so the
 * eval tests exactly what runs in production (`src/prompts/detect-breaking-schema-changes.ts` and
 * `src/prompts/find-schema-consumers.ts`).
 */
export type BreakingChangesEvalInput = {
  /** Fixture directory under evals/fixtures (contains a `catalog/`). */
  fixture: string;
  /** The changed schema file (diff + name) the agent scores for breaking changes. */
  schemaFile: ChangedFile;
  /** Catalog path relative to the fixture root. Defaults to `catalog`. */
  catalogPath?: string;
  /** Stop after scoring the schema. Use for detect-only evals that don't need consumer tracing. */
  detectOnly?: boolean;
};

/** Everything the scorers need about one breaking-changes run. */
export type BreakingChangesEvalOutput = {
  breakingChange: BreakingChangeResponse;
  /** Consumers traced from the catalog, when the consumer phase ran. */
  consumers: SchemaConsumersResponse['consumers'];
  /** Mermaid impact diagram returned by the consumer tracing phase. Empty for detect-only evals. */
  diagram: SchemaConsumersResponse['diagram'];
  /** Every tool the agent invoked, in order. */
  toolCalls: { name: string; phase: 'detect' | 'consumers' }[];
  usage: UsageTotals;
};

const setupWorkspace = async (fixture: string): Promise<string> => {
  const fixtureRoot = join(import.meta.dirname, '..', 'fixtures', fixture);
  const workspace = await mkdtemp(join(tmpdir(), 'ec-bc-eval-'));
  await cp(fixtureRoot, workspace, { recursive: true });
  await git(workspace, ['init', '-q']);
  await git(workspace, ['add', '-A']);
  await git(workspace, ['-c', 'user.email=eval@eventcatalog.dev', '-c', 'user.name=eval', 'commit', '-qm', 'fixture']);
  return workspace;
};

const runScenario = async (input: BreakingChangesEvalInput): Promise<BreakingChangesEvalOutput> => {
  const catalogPath = input.catalogPath ?? 'catalog';
  const workspace = await setupWorkspace(input.fixture);

  const toolCalls: BreakingChangesEvalOutput['toolCalls'] = [];
  const usage: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
  let phase: 'detect' | 'consumers' = 'detect';
  const unobserve = observe((event) => {
    if (event.type === 'tool' && 'toolName' in event && typeof event.toolName === 'string') {
      toolCalls.push({ name: event.toolName, phase });
      if (process.env.EVAL_TRACE) {
        console.error(`  [${phase}] → ${event.toolName} (#${toolCalls.length})`);
      }
    }
    if (event.type === 'operation' && 'usage' in event && event.usage) {
      const u = event.usage;
      usage.inputTokens += u.input;
      usage.outputTokens += u.output;
      usage.cacheReadTokens += u.cacheRead;
      usage.cacheWriteTokens += u.cacheWrite;
      usage.totalTokens += u.totalTokens;
      usage.costUsd += u.cost.total;
    }
  });

  try {
    const payload: ReviewPayload = { workspace, catalogPath, model: MODEL };
    const sandbox = local({ cwd: workspace });
    const ctx = createFlueContext({
      id: `bc-eval-${input.fixture}`,
      payload,
      env: process.env as Record<string, string>,
      agentConfig: { resolveModel, packagedSkills: getPackagedSkills() },
      createDefaultEnv: () => sandbox.createSessionEnv({ id: `bc-eval-${input.fixture}` }),
      defaultStore: new InMemorySessionStore(),
    });

    const harness = await ctx.init(breakingChangesAgent, {});
    const session = await harness.session();

    // 1. Score the schema for breaking changes (the real production prompt).
    const breakingChange = await detectBreakingSchemaChange(session, input.schemaFile);

    if (input.detectOnly) {
      return { breakingChange, consumers: [], diagram: '', toolCalls, usage };
    }

    // 2. Trace the schema to its catalog consumers (the real production prompt).
    phase = 'consumers';
    const { consumers, diagram } = await findSchemaConsumers(session, breakingChange, catalogPath);

    return { breakingChange, consumers, diagram, toolCalls, usage };
  } finally {
    unobserve();
    await rm(workspace, { recursive: true, force: true });
  }
};

/**
 * vitest-evals harness that runs the real breaking-changes prompts against a fixture catalog and
 * returns the structured output for scoring.
 */
export const breakingChangesHarness = createHarness<BreakingChangesEvalInput, BreakingChangesEvalOutput>({
  name: `breaking-changes (${MODEL})`,
  run: async ({ input }) => {
    const output = await runScenario(input);
    return {
      output,
      messages: [
        { role: 'user', content: input.schemaFile.diff },
        { role: 'assistant', content: JSON.parse(JSON.stringify(output)) },
      ],
    };
  },
});
