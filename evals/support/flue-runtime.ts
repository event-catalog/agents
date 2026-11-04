import { observe, type FlueObservation } from '@flue/runtime';
import { start, type Flue } from '@flue/runtime/node';
import { BreakingChanges } from '@/src/agents/breaking-changes';
import { CodeToDocs } from '@/src/agents/code-to-docs';

/** Summed token counts and estimated USD cost for a run, from Flue's per-turn usage. */
export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Estimated cost in USD, computed by Flue from provider pricing. */
  costUsd: number;
};

// One process holds one Flue runtime, and vitest may evaluate this module more than once per worker,
// so the runtime lives on globalThis.
const RUNTIME_KEY = Symbol.for('eventcatalog.evals.flue');
type RuntimeHolder = { [RUNTIME_KEY]?: Promise<Flue> };

/**
 * Boots the Flue runtime in-process (the same `start()` the action uses in `src/run.ts`), once per
 * worker. Conversations are in-memory and vanish with the process.
 */
export const ensureFlueRuntime = (): Promise<Flue> => {
  const holder = globalThis as RuntimeHolder;
  holder[RUNTIME_KEY] ??= start({ agents: [CodeToDocs, BreakingChanges] });
  return holder[RUNTIME_KEY];
};

/** Stops the runtime started by {@link ensureFlueRuntime}, if any. Call from `afterAll`. */
export const stopFlueRuntime = async (): Promise<void> => {
  const holder = globalThis as RuntimeHolder;
  const flue = holder[RUNTIME_KEY];
  delete holder[RUNTIME_KEY];
  await (await flue)?.stop();
};

/**
 * Records every tool the agent invokes and sums model usage while a scenario runs. `phase()` labels
 * each tool call with the step it happened in. Returns an `unobserve` function.
 */
export const recordAgentActivity = <TPhase extends string>(
  phase: () => TPhase,
  toolCalls: { name: string; phase: TPhase }[],
  usage: UsageTotals
): (() => void) =>
  observe((event: FlueObservation) => {
    if (event.type === 'tool') {
      toolCalls.push({ name: event.toolName, phase: phase() });
      // Live trace so you can watch the agent work (and spot loops) instead of waiting for the test
      // to finish. Opt in with EVAL_TRACE=1. console.error streams immediately; console.log buffers.
      if (process.env.EVAL_TRACE) {
        console.error(`  [${phase()}] → ${event.toolName} (#${toolCalls.length})`);
      }
    }
    // Turn usage is Flue's leaf level (operation/compaction events roll it up), so sum turns only.
    if (event.type === 'turn' && event.response.usage) {
      const u = event.response.usage;
      usage.inputTokens += u.input;
      usage.outputTokens += u.output;
      usage.cacheReadTokens += u.cacheRead;
      usage.cacheWriteTokens += u.cacheWrite;
      usage.totalTokens += u.totalTokens;
      usage.costUsd += u.cost.total;
    }
  });

export const emptyUsage = (): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  costUsd: 0,
});
