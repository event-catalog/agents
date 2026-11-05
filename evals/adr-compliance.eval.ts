import { afterAll, expect } from 'vitest';
import { describeEval } from 'vitest-evals';
import { adrComplianceHarness, type AdrComplianceEvalOutput } from './support/adr-compliance-harness';
import { scoreAdrCompliance, type AdrComplianceExpectation } from './support/adr-compliance-scorers';
import { stopFlueRuntime } from './support/flue-runtime';
import { shouldSkipLiveModelEval } from './support/harness';
import {
  commentOnlyMention,
  compliantArchiveEndpoint,
  compliantMediaJob,
  crossServiceDatabaseRead,
  directBrokerPublish,
  inlineImageProcessing,
  promptInjection,
  removedOutboxWrite,
  unrelatedValidation,
} from './fixtures/adr-compliance/scenario';

/**
 * Each test runs the REAL ADR Compliance workflow (real model, real tools) on a fixture pull request.
 * The clean scenarios matter as much as the violations: a reviewer that raises false alarms gets
 * ignored, so a clean pull request that gets any conflict fails.
 *
 * Live tests skip when no model API key is set (see `skipIf`).
 */

/** Print what the agent concluded, so failures are readable without digging through logs. */
const reportRun = ({ result, comment, usage }: AdrComplianceEvalOutput): void => {
  console.log(`\n──── ADR COMPLIANCE (${result.outcome}) ────`);
  console.log(`  checked:  ${result.checkedAdrIds.join(', ')}`);
  console.log(`  relevant: ${result.relevantAdrIds.join(', ') || '(none)'}`);
  for (const { adrId, file, line, explanation } of result.conflicts) {
    console.log(`  conflict: ${adrId} at ${file}:${line}\n    ${explanation}`);
  }
  for (const { conflict, reason } of result.rejected) {
    console.log(`  rejected: ${conflict.adrId} at ${conflict.file}:${conflict.line} (${reason})`);
  }
  if (process.env.EVAL_DUMP && comment) console.log(`\n${comment}`);
  console.log(`  usage: ${usage.totalTokens.toLocaleString()} tokens, ~$${usage.costUsd.toFixed(4)}\n`);
};

const expectScore = (output: AdrComplianceEvalOutput, expectation: AdrComplianceExpectation): void => {
  reportRun(output);
  const { score, failures } = scoreAdrCompliance(output.result, expectation);
  expect(failures, failures.join('\n')).toEqual([]);
  expect(score).toBe(1);
};

afterAll(stopFlueRuntime);

describeEval(
  'adr-compliance agent: checking pull requests against ADRs',
  { harness: adrComplianceHarness, skipIf: shouldSkipLiveModelEval },
  (it) => {
    it('reports image processing added to the API request path', async ({ run }) => {
      const { output } = await run(inlineImageProcessing.input);
      expectScore(output, inlineImageProcessing.expectation);
    });

    it('reports publishing directly to the broker instead of the outbox', async ({ run }) => {
      const { output } = await run(directBrokerPublish.input);
      expectScore(output, directBrokerPublish.expectation);
    });

    it('reports a removed outbox write, citing the deleted line', async ({ run }) => {
      const { output } = await run(removedOutboxWrite.input);
      expectScore(output, removedOutboxWrite.expectation);
    });

    it('reports an org-wide ADR: reading another service database', async ({ run }) => {
      const { output } = await run(crossServiceDatabaseRead.input);
      expectScore(output, crossServiceDatabaseRead.expectation);
    });

    it('still reports a conflict when a code comment tells the reviewer to approve', async ({ run }) => {
      const { output } = await run(promptInjection.input);
      expectScore(output, promptInjection.expectation);
    });

    it('stays silent on an endpoint that follows the ADRs, ignoring proposed and out-of-scope ADRs', async ({ run }) => {
      const { output } = await run(compliantArchiveEndpoint.input);
      expectScore(output, compliantArchiveEndpoint.expectation);
    });

    it('stays silent when a more specific ADR allows the change', async ({ run }) => {
      const { output } = await run(compliantMediaJob.input);
      expectScore(output, compliantMediaJob.expectation);
    });

    it('stays silent when only a comment mentions something an ADR rules out', async ({ run }) => {
      const { output } = await run(commentOnlyMention.input);
      expectScore(output, commentOnlyMention.expectation);
    });

    it('stays silent on a change unrelated to any ADR', async ({ run }) => {
      const { output } = await run(unrelatedValidation.input);
      expectScore(output, unrelatedValidation.expectation);
    });
  }
);
