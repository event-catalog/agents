import { parseArgs } from 'node:util';
import { start } from '@flue/runtime/node';
import { BreakingChanges } from '@/src/agents/breaking-changes';
import { CodeToDocs } from '@/src/agents/code-to-docs';
import type { ReviewPayload } from '@/src/config';
import { run as runBreakingChanges } from '@/src/workflows/breaking-changes';
import { run as runPrReview } from '@/src/workflows/pr-review';

/** Agent name (the action's `agent` input) → the workflow that runs it. */
const WORKFLOWS: Record<string, (payload: ReviewPayload | undefined) => Promise<unknown>> = {
  'code-to-docs': runPrReview,
  'breaking-changes': runBreakingChanges,
};

/**
 * Runs one EventCatalog agent workflow in this process:
 *
 *   tsx src/run.ts <code-to-docs|breaking-changes> [--payload '<json>']
 *
 * Flue 2 removed workflows, so this is a standalone script: `start()` boots the Flue runtime
 * in-process (in-memory storage; nothing outlives the run) and the workflow drives the agent
 * through `init()` handles. The result is printed to stdout; logs go to stderr.
 */
const main = async (): Promise<void> => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { payload: { type: 'string' } },
  });
  const agentName = positionals[0]?.trim() ?? '';
  const workflow = WORKFLOWS[agentName];

  if (!workflow) {
    throw new Error(`Unknown EventCatalog agent '${agentName}'. Available: ${Object.keys(WORKFLOWS).join(', ')}.`);
  }

  const payload = values.payload ? (JSON.parse(values.payload) as ReviewPayload) : undefined;
  const flue = await start({ agents: [CodeToDocs, BreakingChanges] });

  try {
    const result = await workflow(payload);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await flue.stop();
  }
};

main().catch((error: unknown) => {
  if (process.env.GITHUB_ACTIONS === 'true') {
    // Surfaces the failure as an annotation on the workflow run summary.
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  }
  console.error(`[eventcatalog:flue] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exitCode = 1;
});
