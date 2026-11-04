import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createHarness } from 'vitest-evals';
import { CodeToDocs } from '@/src/agents/code-to-docs';
import { initWithData } from '@/src/agents/structured-results';
import type { ReviewPayload } from '@/src/config';
import type { ImpactPlanResponse } from '@/src/review-output';
import { applyDocumentationPlan } from '@/src/prompts/apply-documentation-plan-to-catalog';
import { createDocumentationPlan } from '@/src/prompts/create-documentation-plan-from-code-changes';
import type { ChangedFile } from '@/src/review-types';
import { archivePreviousVersions, type ArchivedVersion } from '@/src/utils/archive-versions';
import { getUnauthorizedCatalogChanges } from '@/src/utils/impact-plan';
import { withVersionPinTargets } from '@/src/utils/version-pins';
import { emptyUsage, ensureFlueRuntime, recordAgentActivity, type UsageTotals } from './flue-runtime';

export type { UsageTotals };

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
  /** The plan the model proposed. */
  impactPlan: ImpactPlanResponse;
  /** The plan the apply step was given: the model's plan plus the version-pin targets the workflow adds. */
  approvedPlan?: ImpactPlanResponse;
  /** Files the agent created/modified/deleted in the catalog during the apply phase. */
  catalogChanges: CatalogFileChange[];
  /** Structured apply-phase response (PR title/summary), when the apply phase ran. */
  applyResult?: { prTitle: string; prSummary: string; sourcePrSummary: string };
  /** Whether the agent touched catalog files outside the approved plan. */
  unauthorizedChanges: string[];
  /** Previous versions the workflow archived under `versioned/` after the agent bumped a version. */
  archivedVersions: ArchivedVersion[];
  /** Every tool the agent invoked, in order — proves whether it used the skill, dump_catalog, linter, etc. */
  toolCalls: ToolCallRecord[];
  /** Aggregated token + cost usage across the whole run (all model operations). */
  usage: UsageTotals;
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

export const shouldSkipLiveModelEval = (): boolean => {
  const provider = MODEL.split('/')[0];
  const keyEnv = PROVIDER_KEY_ENV[provider];

  if (!keyEnv) {
    process.stderr.write(
      `[eventcatalog:evals] Skipping live model evals: model "${MODEL}" uses provider "${provider}", but no required API key env var is configured for that provider. Known providers: ${Object.keys(
        PROVIDER_KEY_ENV
      ).join(', ')}.\n`
    );
    return true;
  }

  if (!process.env[keyEnv]) {
    process.stderr.write(`[eventcatalog:evals] Skipping live model evals: set ${keyEnv} to run model "${MODEL}".\n`);
    return true;
  }

  return false;
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
  // Also sum token + cost usage (Flue computes cost from provider pricing).
  const toolCalls: ToolCallRecord[] = [];
  const usage = emptyUsage();
  let phase: 'plan' | 'apply' = 'plan';
  await ensureFlueRuntime();
  const unobserve = recordAgentActivity(() => phase, toolCalls, usage);

  try {
    // A fresh agent conversation per scenario, seeded with the same payload shape the action sends.
    const payload: ReviewPayload = { workspace, catalogPath, model: MODEL };
    const agent = initWithData(CodeToDocs, payload);

    // The shared review logic operates on the same `changedFiles` shape the workflow builds, so the
    // prompts here are byte-for-byte identical to production. See `src/prompts/`.
    const changedFiles: ChangedFile[] = [{ diff: input.diff, fileName: 'source.diff' }];

    // Ask the agent which docs need to change. The planning step is read-only (enforced by the
    // prompt), and we no longer discard between phases — mirroring production — so any work survives
    // into the applied result rather than being wiped and silently no-op'd by an eager model.
    const { impactPlan, shouldApply } = await createDocumentationPlan(agent, changedFiles, catalogPath);

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
      return { impactPlan, catalogChanges: planPhaseWrites, unauthorizedChanges: [], archivedVersions: [], toolCalls, usage };
    }

    if (!shouldApply) {
      return { impactPlan, catalogChanges: [], unauthorizedChanges: [], archivedVersions: [], toolCalls, usage };
    }

    // As in the workflow: add the resources that pin a planned message's version to the plan, apply it,
    // archive the previous version of anything re-versioned, then check for off-plan edits.
    const approvedPlan = await withVersionPinTargets(impactPlan, catalogAbsPath, catalogPath);
    phase = 'apply';
    const applyResult = await applyDocumentationPlan(agent, approvedPlan, changedFiles, catalogPath);
    const archivedVersions = await archivePreviousVersions(catalogAbsPath);
    const catalogChanges = await collectCatalogChanges(workspace, catalogPath);
    const unauthorizedChanges = getUnauthorizedCatalogChanges(
      catalogChanges.map((c) => c.path),
      approvedPlan,
      catalogPath,
      archivedVersions
    );

    return {
      impactPlan,
      approvedPlan,
      catalogChanges,
      applyResult: {
        prTitle: applyResult.prTitle,
        prSummary: applyResult.prSummary,
        sourcePrSummary: applyResult.sourcePrSummary,
      },
      unauthorizedChanges,
      archivedVersions,
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
