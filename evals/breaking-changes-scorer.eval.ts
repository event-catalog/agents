import { expect, test } from 'vitest';
import type { BreakingChangeResponse, SchemaConsumersResponse } from '@/src/review-output';
import { scoreBreakingChange, scoreConsumers } from './support/breaking-changes-scorers';
import { orderConfirmedBreaking, orderConfirmedAdditive } from './fixtures/breaking-change-order-confirmed/scenario';

/**
 * Offline guard for the deterministic breaking-changes scorers used by the live eval. Runs without a
 * model or API key, so it always executes in CI and pins the pass/fail bar against known-good and
 * known-bad results so the live eval can't silently drift.
 */

const breakingResult: BreakingChangeResponse = {
  fileName: 'catalog/domains/Orders/services/OrdersService/events/OrderConfirmed/schema.json',
  isBreaking: true,
  confidence: 'high',
  summary: 'Removes the required field orderStatus, which existing consumers read.',
  breakingChanges: [
    {
      change: 'Removed required field `orderStatus`.',
      lines: '-  "required": ["orderId", "orderStatus"]\n+  "required": ["orderId"]',
    },
  ],
};

const additiveResult: BreakingChangeResponse = {
  fileName: 'catalog/domains/Orders/services/OrdersService/events/OrderConfirmed/schema.json',
  isBreaking: false,
  confidence: 'high',
  summary: 'Adds an optional currency field. Additive and non-breaking.',
  breakingChanges: [],
};

const consumers: SchemaConsumersResponse['consumers'] = [
  {
    id: 'NotificationsService',
    version: '1.0.0',
    type: 'service',
    path: 'domains/Notifications/services/NotificationsService',
    reason: 'Receives the OrderConfirmed event.',
  },
];

test('scores a correctly-detected breaking change as a perfect pass', () => {
  const { score, failures } = scoreBreakingChange(breakingResult, orderConfirmedBreaking.breakingExpectation);
  expect(failures).toEqual([]);
  expect(score).toBe(1);
});

test('scores a correctly-detected additive change as a perfect pass', () => {
  const { score, failures } = scoreBreakingChange(additiveResult, orderConfirmedAdditive.breakingExpectation);
  expect(failures).toEqual([]);
  expect(score).toBe(1);
});

test('penalizes calling an additive change breaking', () => {
  const wrong: BreakingChangeResponse = { ...additiveResult, isBreaking: true };
  const { score, failures } = scoreBreakingChange(wrong, orderConfirmedAdditive.breakingExpectation);
  expect(score).toBeLessThan(1);
  expect(failures.some((f) => f.includes('isBreaking'))).toBe(true);
});

test('scores finding the consumer (and not the producer) as a perfect pass', () => {
  const { score, failures } = scoreConsumers(consumers, orderConfirmedBreaking.consumersExpectation);
  expect(failures).toEqual([]);
  expect(score).toBe(1);
});

test('penalizes reporting the producer as a consumer', () => {
  const withProducer: SchemaConsumersResponse['consumers'] = [
    ...consumers,
    {
      id: 'OrdersService',
      version: '1.0.0',
      type: 'service',
      path: 'domains/Orders/services/OrdersService',
      reason: 'Sends the event.',
    },
  ];
  const { score, failures } = scoreConsumers(withProducer, orderConfirmedBreaking.consumersExpectation);
  expect(score).toBeLessThan(1);
  expect(failures.some((f) => f.includes('OrdersService'))).toBe(true);
});

test('penalizes missing the consumer entirely', () => {
  const { score, failures } = scoreConsumers([], orderConfirmedBreaking.consumersExpectation);
  expect(score).toBeLessThan(1);
  expect(failures.some((f) => f.includes('NotificationsService'))).toBe(true);
});
