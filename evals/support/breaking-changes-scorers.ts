import type { BreakingChangeResponse, SchemaConsumersResponse } from '@/src/review-output';

/**
 * Deterministic, model-free scorers for the breaking-changes prompts. Kept separate from the harness
 * so they can be pinned offline (see `breaking-changes-scorer.eval.ts`).
 */

export type ScoreResult = { score: number; failures: string[] };

/** What a detect-breaking-change run should conclude. */
export type BreakingChangeExpectation = {
  /** Whether the schema change is breaking. */
  isBreaking: boolean;
  /** When breaking, at least one highlighted breaking change must mention one of these terms. */
  mentions?: string[];
};

/** What a consumer-tracing run should find. */
export type ConsumersExpectation = {
  /** Consumer ids the agent must find (matched case- and separator-insensitively). */
  requiredConsumerIds: string[];
  /** Consumer ids the agent must NOT report (e.g. the producer of the message). */
  forbiddenConsumerIds?: string[];
};

const normalizeId = (id: string): string => id.toLowerCase().replace(/[\s_-]+/g, '');

export const scoreBreakingChange = (result: BreakingChangeResponse, expect: BreakingChangeExpectation): ScoreResult => {
  const failures: string[] = [];
  let checks = 0;

  checks += 1;
  if (result.isBreaking !== expect.isBreaking) {
    failures.push(`Expected isBreaking to be ${expect.isBreaking}, got ${result.isBreaking}.`);
  }

  // Only check highlighted lines/terms when we expect (and got) a breaking change.
  if (expect.isBreaking && expect.mentions && expect.mentions.length > 0) {
    checks += 1;
    const haystack = [result.summary, ...result.breakingChanges.flatMap((c) => [c.change, c.lines])].join('\n').toLowerCase();
    const matched = expect.mentions.some((term) => haystack.includes(term.toLowerCase()));
    if (!matched) {
      failures.push(`Expected the breaking change to mention one of: ${expect.mentions.join(', ')}.`);
    }
  }

  const total = Math.max(checks, 1);
  return { score: (total - failures.length) / total, failures };
};

export const scoreConsumers = (consumers: SchemaConsumersResponse['consumers'], expect: ConsumersExpectation): ScoreResult => {
  const failures: string[] = [];
  let checks = 0;
  const foundIds = consumers.map((c) => normalizeId(c.id));

  for (const required of expect.requiredConsumerIds) {
    checks += 1;
    if (!foundIds.includes(normalizeId(required))) {
      failures.push(`Expected consumers to include "${required}".`);
    }
  }

  for (const forbidden of expect.forbiddenConsumerIds ?? []) {
    checks += 1;
    if (foundIds.includes(normalizeId(forbidden))) {
      failures.push(`Expected consumers NOT to include "${forbidden}" (it is the producer, not a consumer).`);
    }
  }

  const total = Math.max(checks, 1);
  return { score: (total - failures.length) / total, failures };
};
