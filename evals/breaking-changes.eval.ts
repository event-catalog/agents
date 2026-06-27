import { expect } from 'vitest';
import { describeEval } from 'vitest-evals';
import { breakingChangesHarness, type BreakingChangesEvalOutput } from './support/breaking-changes-harness';
import { hasModelCredentials } from './support/harness';
import { scoreBreakingChange, scoreConsumers } from './support/breaking-changes-scorers';
import type { BreakingChangeExpectation, ConsumersExpectation } from './support/breaking-changes-scorers';
import { orderConfirmedBreaking, orderConfirmedAdditive } from './fixtures/breaking-change-order-confirmed/scenario';

/**
 * Each test runs the REAL breaking-changes prompts (real model, the `dump_catalog` tool, and the
 * skill) against a fixture catalog and scores the structured output. These are the first, basic
 * evals: one breaking change (with consumer tracing) and one additive, non-breaking change.
 *
 * Live tests skip when no model API key is set (see `skipIf`).
 */

/** Print what the agent concluded, so failures are readable without digging through logs. */
const reportRun = (output: BreakingChangesEvalOutput): void => {
  const { breakingChange, consumers, usage } = output;
  console.log(`\n──── BREAKING CHANGE (${breakingChange.fileName}) ────`);
  console.log(`  isBreaking: ${breakingChange.isBreaking} (${breakingChange.confidence})`);
  console.log(`  summary: ${breakingChange.summary}`);
  for (const c of breakingChange.breakingChanges) {
    console.log(`    - ${c.change}`);
  }
  if (consumers.length) {
    console.log('  consumers:');
    for (const c of consumers) console.log(`    - ${c.id} (${c.type}) — ${c.reason}`);
  }
  console.log(`  usage: ${usage.totalTokens.toLocaleString()} tokens, ~$${usage.costUsd.toFixed(4)}\n`);
};

const expectBreaking = (output: BreakingChangesEvalOutput, expectation: BreakingChangeExpectation): void => {
  const { score, failures } = scoreBreakingChange(output.breakingChange, expectation);
  expect(failures, failures.join('\n')).toEqual([]);
  expect(score).toBe(1);
};

const expectConsumers = (output: BreakingChangesEvalOutput, expectation: ConsumersExpectation): void => {
  const found = output.consumers.map((c) => c.id).join(', ') || '(none)';
  const { score, failures } = scoreConsumers(output.consumers, expectation);
  expect(failures, `${failures.join('\n')}\n\nThe agent found consumers: ${found}`).toEqual([]);
  expect(score).toBe(1);
};

describeEval(
  'breaking-changes agent: scoring schema changes and finding affected consumers',
  { harness: breakingChangesHarness, skipIf: () => !hasModelCredentials() },
  (it) => {
    it('flags a removed required field as breaking and traces it to the consuming service', async ({ run }) => {
      const { output } = await run(orderConfirmedBreaking.input);
      reportRun(output);

      // Detect: removing the required `orderStatus` field is breaking, and it's highlighted.
      expectBreaking(output, orderConfirmedBreaking.breakingExpectation);

      // Consumers: NotificationsService receives the event; OrdersService (the producer) does not count.
      expectConsumers(output, orderConfirmedBreaking.consumersExpectation);
    });

    it('treats a new optional field as a non-breaking, additive change', async ({ run }) => {
      const { output } = await run(orderConfirmedAdditive.input);
      reportRun(output);

      // Detect-only: adding an optional `currency` field does not break existing consumers.
      expectBreaking(output, orderConfirmedAdditive.breakingExpectation);
    });
  }
);
