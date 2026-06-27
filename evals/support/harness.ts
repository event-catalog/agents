import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createHarness } from 'vitest-evals';
import { observe } from '@flue/runtime';
import { createFlueContext, InMemorySessionStore, resolveModel } from '@flue/runtime/internal';
import { local } from '@flue/runtime/node';
import codeToDocsAgent from '@/src/agents/code-to-docs';
import type { ReviewPayload } from '@/src/config';
import type { ImpactPlanResponse } from '@/src/review-output';
import { applyDocumentationPlan } from '@/src/prompts/apply-documentation-plan-to-catalog';
import { createDocumentationPlan } from '@/src/prompts/create-documentation-plan-from-code-changes';
import type { ChangedFile } from '@/src/review-types';
import { getUnauthorizedCatalogChanges } from '@/src/utils/impact-plan';
import { getPackagedSkills } from './skill-registry';

const exec = promisify(execFile);

/** One eval scenario: a fixture directory plus the source diff to feed the agent. */
export type AgentEvalInput = {
  /** Fixture directory under evals/fixtures (contains a `catalog/` and a source `diff`). */
  fixture: string;
  /** Source PR diff the agent reviews. */
  diff: string;
  /** Catalog path relative to the fixture root. Defaults to `catalog`. */
  catalogPath?: string;
  /** Stop after the impact-plan phase. Cheaper; use for plan-only evals. */
  planOnly?: boolean;
};

/** Everything the scorers and judges need about one agent run. */
export type AgentEvalOutput = {
  impactPlan: ImpactPlanResponse;
  /** Files the agent created/modified/deleted in the catalog during the apply phase. */
  catalogChanges: CatalogFileChange[];
  /** Structured apply-phase response (PR title/summary), when the apply phase ran. */
  applyResult?: { prTitle: string; prSummary: string; sourcePrSummary: string };
  /** Whether the agent touched catalog files outside the approved plan. */
  unauthorizedChanges: string[];
  /** Every tool the agent invoked, in order — proves whether it used the skill, dump_catalog, linter, etc. */
  toolCalls: ToolCallRecord[];
  /** Aggregated token + cost usage across the whole run (all model operations). */
  usage: UsageTotals;
};

/** Summed token counts and estimated USD cost for a run, from Flue's per-operation usage. */
export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Estimated cost in USD, computed by Flue from provider pricing. */
  costUsd: number;
};

export type ToolCallRecord = {
  /** Tool name, e.g. `dump_catalog`, `linter`, `read`, or the skill tool. */
  name: string;
  /** Which review step the call happened in. */
  phase: 'plan' | 'apply';
};

export type CatalogFileChange = {
  /** Path relative to the catalog root. */
  path: string;
  status: 'added' | 'modified' | 'deleted';
  /** New file contents (undefined for deletions). */
  content?: string;
};

export const MODEL = process.env.EVENTCATALOG_MODEL ?? process.env.MODEL ?? 'openai/gpt-4o-mini';

/** Provider API-key env var by model-specifier prefix. Suites skip when the key is absent. */
const PROVIDER_KEY_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

/** Live evals need a real key for whatever provider the model under test uses. */
export const hasModelCredentials = (): boolean => {
  const provider = MODEL.split('/')[0];
  const keyEnv = PROVIDER_KEY_ENV[provider];
  return keyEnv ? Boolean(process.env[keyEnv]) : false;
};

const git = (cwd: string, args: string[]) => exec('git', args, { cwd, maxBuffer: 1024 * 1024 * 20 });

const setupWorkspace = async (fixture: string): Promise<string> => {
  const fixtureRoot = join(import.meta.dirname, '..', 'fixtures', fixture);
  const workspace = await mkdtemp(join(tmpdir(), 'ec-eval-'));
  await cp(fixtureRoot, workspace, { recursive: true });
  await git(workspace, ['init', '-q']);
  await git(workspace, ['add', '-A']);
  await git(workspace, ['-c', 'user.email=eval@eventcatalog.dev', '-c', 'user.name=eval', 'commit', '-qm', 'fixture']);
  return workspace;
};

const collectCatalogChanges = async (workspace: string, catalogPath: string): Promise<CatalogFileChange[]> => {
  // The git repo root is the workspace, so `git status` reports paths relative to the workspace
  // (e.g. `catalog/domains/...`), regardless of which subdir we run it from. We read file contents
  // against the workspace, then strip the catalog prefix so downstream paths are catalog-relative.
  // `-uall` lists every individual untracked file; without it git collapses a new directory into a
  // single `path/` entry, so a freshly created `OrderRefunded/index.mdx` would be invisible.
  const { stdout } = await git(workspace, ['status', '--porcelain', '-uall']);
  const prefix = `${catalogPath.replace(/\/+$/, '')}/`;
  const changes: CatalogFileChange[] = [];
  for (const line of stdout.split('\n').filter((l) => l.trim())) {
    const code = line.slice(0, 2).trim();
    const repoPath = line.slice(3).trim();
    if (!repoPath.startsWith(prefix)) continue; // ignore changes outside the catalog
    const path = repoPath.slice(prefix.length);
    const status = code.includes('D') ? 'deleted' : code === '??' || code.includes('A') ? 'added' : 'modified';
    const change: CatalogFileChange = { path, status };
    if (status !== 'deleted') {
      change.content = await readFile(join(workspace, repoPath), 'utf8').catch(() => undefined);
    }
    changes.push(change);
  }
  return changes;
};

const runAgentScenario = async (input: AgentEvalInput): Promise<AgentEvalOutput> => {
  const catalogPath = input.catalogPath ?? 'catalog';
  const workspace = await setupWorkspace(input.fixture);
  const catalogAbsPath = join(workspace, catalogPath);

  // Record every tool the agent invokes (Flue surfaces tool + skill calls as `tool` events), so we
  // can prove whether it actually consulted the skill / dump_catalog rather than working blind.
  // Also sum token + cost usage from `operation` events (Flue computes cost from provider pricing).
  const toolCalls: ToolCallRecord[] = [];
  const usage: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
  let phase: 'plan' | 'apply' = 'plan';
  const unobserve = observe((event) => {
    if (event.type === 'tool' && 'toolName' in event && typeof event.toolName === 'string') {
      toolCalls.push({ name: event.toolName, phase });
      // Live trace so you can watch the agent work (and spot loops) instead of waiting for the test
      // to finish. Opt in with EVAL_TRACE=1. console.error streams immediately; console.log buffers.
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
    // The agent supplies its own `sandbox: local({ cwd })`, which `init` uses. `createDefaultEnv`
    // is the context fallback; delegate to the same local sandbox so both agree on the workspace.
    const sandbox = local({ cwd: workspace });
    const ctx = createFlueContext({
      id: `eval-${input.fixture}`,
      payload,
      env: process.env as Record<string, string>,
      agentConfig: { resolveModel, packagedSkills: getPackagedSkills() },
      createDefaultEnv: () => sandbox.createSessionEnv({ id: `eval-${input.fixture}` }),
      defaultStore: new InMemorySessionStore(),
    });

    const harness = await ctx.init(codeToDocsAgent, {});
    const session = await harness.session();

    // The shared review logic operates on the same `changedFiles` shape the workflow builds, so the
    // prompts here are byte-for-byte identical to production. See `src/prompts/`.
    const changedFiles: ChangedFile[] = [{ diff: input.diff, fileName: 'source.diff' }];

    // Ask the agent which docs need to change. The planning step is read-only (enforced by the
    // prompt), and we no longer discard between phases — mirroring production — so any work survives
    // into the applied result rather than being wiped and silently no-op'd by an eager model.
    const { impactPlan, shouldApply } = await createDocumentationPlan(session, changedFiles, catalogPath);

    // Diagnostic: flag if the agent ignored "read-only" and wrote during planning anyway.
    const planPhaseWrites = await collectCatalogChanges(workspace, catalogPath);
    if (planPhaseWrites.length > 0) {
      console.error(
        `[eval] planning step wrote ${planPhaseWrites.length} file(s): ${planPhaseWrites.map((c) => c.path).join(', ')}`
      );
    }

    if (input.planOnly) {
      // For plan-only evals we still reset so the planning step leaves no artifacts.
      await git(catalogAbsPath, ['restore', '--staged', '--worktree', '.']).catch(() => {});
      await git(catalogAbsPath, ['clean', '-fdq']).catch(() => {});
      return { impactPlan, catalogChanges: planPhaseWrites, unauthorizedChanges: [], toolCalls, usage };
    }

    if (!shouldApply) {
      return { impactPlan, catalogChanges: [], unauthorizedChanges: [], toolCalls, usage };
    }

    // Apply the approved catalog edits.
    phase = 'apply';
    const applyResult = await applyDocumentationPlan(session, impactPlan, changedFiles, catalogPath);
    const catalogChanges = await collectCatalogChanges(workspace, catalogPath);
    const unauthorizedChanges = getUnauthorizedCatalogChanges(
      catalogChanges.map((c) => c.path),
      impactPlan,
      catalogPath
    );

    return {
      impactPlan,
      catalogChanges,
      applyResult: {
        prTitle: applyResult.prTitle,
        prSummary: applyResult.prSummary,
        sourcePrSummary: applyResult.sourcePrSummary,
      },
      unauthorizedChanges,
      toolCalls,
      usage,
    };
  } finally {
    unobserve();
    await rm(workspace, { recursive: true, force: true });
  }
};

/**
 * vitest-evals harness that runs the real code-to-docs agent (real model, tools, skill) against a
 * fixture catalog and returns its structured output for scoring. This is the "given this model +
 * harness + conditions, what's the score?" engine.
 */
export const codeToDocsHarness = createHarness<AgentEvalInput, AgentEvalOutput>({
  name: `code-to-docs (${MODEL})`,
  run: async ({ input }) => {
    const output = await runAgentScenario(input);
    return {
      output,
      messages: [
        { role: 'user', content: input.diff },
        { role: 'assistant', content: JSON.parse(JSON.stringify(output)) },
      ],
    };
  },
});
