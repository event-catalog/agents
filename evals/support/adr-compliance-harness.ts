import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createHarness } from 'vitest-evals';
import { resolveConfig, type ReviewPayload } from '@/src/config';
import { formatAdrComplianceComment } from '@/src/utils/github/reporter';
import { review, type AdrComplianceResult } from '@/src/workflows/adr-compliance';
import { emptyUsage, ensureFlueRuntime, recordAgentActivity, type UsageTotals } from './flue-runtime';
import { MODEL } from './harness';

const exec = promisify(execFile);

/**
 * One ADR Compliance eval scenario. It commits the fixture, applies `edits` as a second commit, and
 * runs the REAL workflow on that diff (ADR selection, triage, review, and citation checks). With no
 * GitHub context in the config, the workflow posts no comment.
 */
export type AdrComplianceEvalInput = {
  /** Fixture directory under evals/fixtures (contains `catalog/` and `src/`). */
  fixture: string;
  /** The `adrs` input. */
  adrs: string;
  /** The pull request: exact text replacements in the fixture's source files. */
  edits: { path: string; find: string; replace: string }[];
  /** The pull request description. */
  pullRequestBody?: string;
};

export type AdrComplianceEvalOutput = {
  result: AdrComplianceResult;
  /** The comment the run would post. Empty when it would stay silent. */
  comment: string;
  toolCalls: { name: string; phase: 'review' }[];
  usage: UsageTotals;
};

const runScenario = async (input: AdrComplianceEvalInput): Promise<AdrComplianceEvalOutput> => {
  const workspace = await mkdtemp(join(tmpdir(), 'ec-adr-eval-'));
  const git = async (...args: string[]) => {
    const { stdout } = await exec('git', ['-c', 'user.email=eval@eventcatalog.dev', '-c', 'user.name=eval', ...args], {
      cwd: workspace,
    });
    return stdout.trim();
  };

  const toolCalls: AdrComplianceEvalOutput['toolCalls'] = [];
  const usage = emptyUsage();
  await ensureFlueRuntime();
  const unobserve = recordAgentActivity(() => 'review' as const, toolCalls, usage);

  try {
    await cp(join(import.meta.dirname, '..', 'fixtures', input.fixture), workspace, { recursive: true });
    await git('init', '-q');
    await git('add', '-A');
    await git('commit', '-qm', 'base');
    const baseSha = await git('rev-parse', 'HEAD');

    for (const { path, find, replace } of input.edits) {
      const content = await readFile(join(workspace, path), 'utf8');
      if (!content.includes(find)) throw new Error(`Scenario edit not found in ${path}: ${find}`);
      await writeFile(join(workspace, path), content.replace(find, replace));
    }
    await git('add', '-A');
    await git('commit', '-qm', 'pull request');
    const headSha = await git('rev-parse', 'HEAD');

    const payload: ReviewPayload = {
      adrs: input.adrs,
      baseSha,
      catalogPath: 'catalog',
      headSha,
      model: MODEL,
      pullRequestBody: input.pullRequestBody,
      workspace,
    };
    // An empty environment, so an eval can never pick up GitHub credentials and post a real comment.
    const config = resolveConfig(payload, {});
    const result = await review(payload, config);
    const { conflicts, exceptions, adrs } = result;
    const comment =
      conflicts.length > 0 || exceptions.length > 0 ? formatAdrComplianceComment({ conflicts, exceptions, adrs }, config) : '';

    return { result, comment, toolCalls, usage };
  } finally {
    unobserve();
    await rm(workspace, { recursive: true, force: true });
  }
};

/** vitest-evals harness that runs the real ADR Compliance workflow on a fixture pull request. */
export const adrComplianceHarness = createHarness<AdrComplianceEvalInput, AdrComplianceEvalOutput>({
  name: `adr-compliance (${MODEL})`,
  run: async ({ input }) => {
    const output = await runScenario(input);
    return {
      output,
      messages: [
        { role: 'user', content: JSON.stringify(input.edits) },
        { role: 'assistant', content: JSON.parse(JSON.stringify(output)) },
      ],
    };
  },
});
