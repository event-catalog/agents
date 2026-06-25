import { expect, test } from 'vitest';
import type { ImpactPlanResponse } from '@/src/review-output';
import { scoreImpactPlan } from './support/scorers';
import { orderRefunded } from './fixtures/order-refunded/scenario';

/**
 * Offline guard for the deterministic scorer used by the live `code-to-docs` eval. Runs without a
 * model or API key, so it always executes in CI. It pins the scorer's behavior against a known-good
 * plan and a known-bad (over-reaching) plan so the live eval's pass/fail bar can't silently drift.
 */

const goodPlan: ImpactPlanResponse = {
  catalogChangesRequired: true,
  sourcePrSummary: 'Adds support for refunding orders and publishing OrderRefunded.',
  sourceChanges: [
    {
      confidence: 'high',
      description: 'OrdersService now publishes OrderRefunded when an order is refunded.',
      evidence: ['src/contracts/messages.js', 'src/orders-service.js'],
      id: 'OrderRefunded',
      type: 'event-added',
    },
  ],
  proposedCatalogTargets: [
    {
      action: 'create',
      path: 'domains/Orders/services/OrdersService/events/OrderRefunded/index.mdx',
      reason: 'OrderRefunded is a new event introduced by the source diff.',
    },
    {
      action: 'create',
      path: 'domains/Orders/services/OrdersService/events/OrderRefunded/schema.json',
      reason: 'The new event needs a schema for its payload.',
    },
    {
      action: 'update',
      path: 'domains/Orders/services/OrdersService/index.mdx',
      reason: 'OrdersService now publishes OrderRefunded.',
    },
  ],
  outOfScopeFindings: [],
};

// Over-reaching plan: invents unrelated channel pages and drops the OrdersService update.
const channelDriftPlan: ImpactPlanResponse = {
  ...goodPlan,
  proposedCatalogTargets: [
    {
      action: 'create',
      path: 'channels/orders-service-sqs-channel/index.mdx',
      reason: 'The channel appears in the changed source file.',
    },
  ],
};

test('scores the desired OrderRefunded plan as a perfect pass', () => {
  const { score, failures } = scoreImpactPlan(goodPlan, orderRefunded.planExpectation);
  expect(failures).toEqual([]);
  expect(score).toBe(1);
});

test('accepts catalog-prefixed target paths the same as catalog-relative ones', () => {
  // Some models propose `catalog/domains/...`, others `domains/...`. Both name the same resource,
  // so the scorer normalizes the prefix away and still scores a perfect plan.
  const prefixedPlan: ImpactPlanResponse = {
    ...goodPlan,
    proposedCatalogTargets: goodPlan.proposedCatalogTargets.map((t) => ({ ...t, path: `catalog/${t.path}` })),
  };
  const { score, failures } = scoreImpactPlan(prefixedPlan, orderRefunded.planExpectation);
  expect(failures).toEqual([]);
  expect(score).toBe(1);
});

test('penalizes an over-reaching plan that invents unrelated channels', () => {
  const { score, failures } = scoreImpactPlan(channelDriftPlan, orderRefunded.planExpectation);
  expect(score).toBeLessThan(1);
  expect(failures.some((f) => f.includes('channels'))).toBe(true);
  expect(failures.some((f) => f.includes('OrdersService/index.mdx'))).toBe(true);
});
