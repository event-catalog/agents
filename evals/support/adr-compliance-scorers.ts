import type { AdrComplianceResult } from '@/src/workflows/adr-compliance';

/**
 * Deterministic, model-free scorer for ADR Compliance. Kept separate from the harness so it can be
 * pinned offline (see `adr-compliance-guard.eval.ts`).
 */

export type AdrComplianceExpectation = {
  /**
   * The ADRs the pull request conflicts with. Every one must be reported with a citation that passed
   * verification, and reporting any other ADR is a failure. Empty means a clean pull request.
   */
  conflictingAdrIds: string[];
};

export type ScoreResult = { score: number; failures: string[] };

export const scoreAdrCompliance = (
  result: Pick<AdrComplianceResult, 'conflicts' | 'rejected'>,
  { conflictingAdrIds }: AdrComplianceExpectation
): ScoreResult => {
  const failures: string[] = [];
  const reported = new Set(result.conflicts.map((conflict) => conflict.adrId));
  const rejected = new Set(result.rejected.map(({ conflict }) => conflict.adrId));

  for (const adrId of conflictingAdrIds) {
    if (!reported.has(adrId)) {
      failures.push(
        rejected.has(adrId)
          ? `Expected a conflict with "${adrId}", but its citation failed verification.`
          : `Expected a conflict with "${adrId}", but it was not reported.`
      );
    }
  }

  // Anything else is a false alarm, including a second ADR flagged for the same problem: the developer
  // would read one problem as two.
  for (const adrId of reported) {
    if (!conflictingAdrIds.includes(adrId)) {
      failures.push(`Did not expect a conflict with "${adrId}", but it was reported.`);
    }
  }

  const checks = Math.max(conflictingAdrIds.length, 1);
  return { score: Math.max(0, (checks - failures.length) / checks), failures };
};
