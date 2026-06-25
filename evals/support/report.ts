import type { AgentEvalOutput } from './harness';

/**
 * Human-readable run report for the live `code-to-docs` eval. Keeps all presentation out of the
 * test file so the tests stay just assertions. Call `reportRun(output)` once per run.
 *
 * Set `EVAL_DUMP=1` to also print the full contents of every file the agent wrote.
 */

const section = (title: string, lines: string[]): void => {
  console.log(`\n──── ${title} ────`);
  for (const line of lines) console.log(line);
  console.log('');
};

const countBy = (names: string[]): Record<string, number> =>
  names.reduce<Record<string, number>>((acc, n) => ((acc[n] = (acc[n] ?? 0) + 1), acc), {});

const reportUsage = ({ usage }: AgentEvalOutput): void => {
  const lines = [
    `  input:  ${usage.inputTokens.toLocaleString()} tokens`,
    `  output: ${usage.outputTokens.toLocaleString()} tokens`,
  ];
  if (usage.cacheReadTokens || usage.cacheWriteTokens) {
    lines.push(`  cache:  ${usage.cacheReadTokens.toLocaleString()} read / ${usage.cacheWriteTokens.toLocaleString()} write`);
  }
  lines.push(`  total:  ${usage.totalTokens.toLocaleString()} tokens`, `  cost:   ~$${usage.costUsd.toFixed(4)}`);
  section('USAGE', lines);
};

const reportTools = ({ toolCalls }: AgentEvalOutput): void => {
  if (toolCalls.length === 0) {
    section('TOOL CALLS', ['  (none — the agent did NOT call any tools or the skill!)']);
    return;
  }
  const counts = countBy(toolCalls.map((t) => t.name));
  section('TOOL CALLS', [
    ...Object.entries(counts).map(([name, n]) => `  ${name} ×${n}`),
    `  order: ${toolCalls.map((t) => `${t.phase}:${t.name}`).join(' → ')}`,
  ]);
};

const reportPlan = ({ impactPlan }: AgentEvalOutput): void => {
  const lines = [
    `  catalogChangesRequired: ${impactPlan.catalogChangesRequired}`,
    `  sourcePrSummary: ${impactPlan.sourcePrSummary}`,
    '  sourceChanges:',
    ...impactPlan.sourceChanges.map((c) => `    - [${c.type}] ${c.id} (${c.confidence}) — ${c.description}`),
    '  proposedCatalogTargets:',
    ...impactPlan.proposedCatalogTargets.flatMap((t) => [`    - ${t.action.toUpperCase()} ${t.path}`, `        ↳ ${t.reason}`]),
  ];
  if (impactPlan.outOfScopeFindings.length) {
    lines.push('  outOfScopeFindings:', ...impactPlan.outOfScopeFindings.map((f) => `    - ${f}`));
  }
  section('IMPACT PLAN', lines);
};

const reportChanges = ({ catalogChanges, applyResult }: AgentEvalOutput): void => {
  const lines: string[] = [];
  for (const c of catalogChanges) {
    lines.push(`  ${c.status.toUpperCase()} ${c.path}`);
    if (process.env.EVAL_DUMP && c.content) {
      lines.push('  ┌─────', ...c.content.split('\n').map((l) => `  │ ${l}`), '  └─────');
    }
  }
  if (applyResult) {
    lines.push('', `  PR title:   ${applyResult.prTitle}`, `  PR summary: ${applyResult.prSummary}`);
  }
  section('CATALOG CHANGES', lines);
};

/** Print everything we captured about one agent run: tools used, usage/cost, plan, and changes. */
export const reportRun = (output: AgentEvalOutput): void => {
  reportTools(output);
  reportUsage(output);
  reportPlan(output);
  if (output.catalogChanges.length || output.applyResult) reportChanges(output);
};
