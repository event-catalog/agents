import type { ImpactPlanResponse } from '@/src/review-output';

/**
 * Deterministic, model-free scorers for an impact plan. These encode the hard constraints we never
 * want to regress: the right catalog targets are proposed, forbidden ones are not, and unrelated
 * drift is reported out of scope. Kept separate from the harness so they can be unit-tested offline.
 */
export type ImpactPlanExpectation = {
  /** Catalog targets (paths relative to catalog root) the plan must include. */
  requiredTargets: string[];
  /** Catalog targets the plan must NOT include. */
  forbiddenTargets: string[];
  /** A source change the plan must identify, e.g. { id: 'OrderRefunded', type: 'event-added' }. */
  requiredSourceChange?: { id: string; type: string };
  /** Regex the outOfScopeFindings must match at least once (unrelated drift). */
  expectOutOfScope?: RegExp;
  /** When false, asserts the plan reports no catalog changes required (no-op PRs). */
  expectChangesRequired?: boolean;
};

export type ScoreResult = { score: number; failures: string[] };

// Models phrase catalog targets inconsistently — some prefix the catalog dir (`catalog/domains/...`),
// some don't (`domains/...`). Strip a leading catalog-root segment so we score WHICH resource was
// proposed, not the exact path string. Also normalizes `./` and trailing slashes.
const normalizeTarget = (value: string): string =>
  value
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/^(catalog|eventcatalog)\//, '');

const targetMatches = (rawA: string, rawB: string): boolean => {
  const a = normalizeTarget(rawA);
  const b = normalizeTarget(rawB);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
};

export const scoreImpactPlan = (plan: ImpactPlanResponse, expect: ImpactPlanExpectation): ScoreResult => {
  const failures: string[] = [];
  const targets = plan.proposedCatalogTargets.map((t) => t.path);
  let checks = 0;

  const expectChanges = expect.expectChangesRequired ?? true;
  checks += 1;
  if (plan.catalogChangesRequired !== expectChanges) {
    failures.push(`Expected catalogChangesRequired to be ${expectChanges}.`);
  }

  if (expect.requiredSourceChange) {
    checks += 1;
    // `type` must match the controlled vocabulary exactly, but `id` is a free-form concept name —
    // models phrase it as PaymentsService / payments-service / "Payments Service" interchangeably,
    // so compare ids case- and separator-insensitively.
    const normalizeId = (id: string) => id.toLowerCase().replace(/[\s_-]+/g, '');
    const wantId = normalizeId(expect.requiredSourceChange.id);
    const found = plan.sourceChanges.some((c) => normalizeId(c.id) === wantId && c.type === expect.requiredSourceChange!.type);
    if (!found) {
      failures.push(`Expected sourceChanges to include ${expect.requiredSourceChange.type}:${expect.requiredSourceChange.id}.`);
    }
  }

  for (const required of expect.requiredTargets) {
    checks += 1;
    if (!targets.some((t) => targetMatches(t, required))) {
      failures.push(`Expected proposedCatalogTargets to include ${required}.`);
    }
  }

  for (const forbidden of expect.forbiddenTargets) {
    checks += 1;
    if (targets.some((t) => targetMatches(t, forbidden))) {
      failures.push(`Expected proposedCatalogTargets not to include ${forbidden}.`);
    }
  }

  if (expect.expectOutOfScope) {
    checks += 1;
    if (!plan.outOfScopeFindings.some((f) => expect.expectOutOfScope!.test(f))) {
      failures.push('Expected outOfScopeFindings to mention the unrelated drift.');
    }
  }

  const total = Math.max(checks, 1);
  return { score: (total - failures.length) / total, failures };
};
