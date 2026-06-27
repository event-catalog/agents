import type { ChangedFile } from '@/src/review-types';
import type { BreakingChangesEvalInput } from '../../support/breaking-changes-harness';
import type { BreakingChangeExpectation, ConsumersExpectation } from '../../support/breaking-changes-scorers';

/**
 * Breaking schema change: the OrderConfirmed schema removes the required `orderStatus` field.
 * Removing a required field breaks any consumer that reads it, so the agent should mark this
 * isBreaking: true and trace it to NotificationsService (which receives OrderConfirmed). The
 * producer (OrdersService, which sends it) must NOT be reported as a consumer.
 */
const breakingDiff = `diff --git a/catalog/domains/Orders/services/OrdersService/events/OrderConfirmed/schema.json b/catalog/domains/Orders/services/OrdersService/events/OrderConfirmed/schema.json
@@
   "properties": {
-    "orderId": { "type": "string" },
-    "orderStatus": { "type": "string" }
+    "orderId": { "type": "string" }
   },
-  "required": ["orderId", "orderStatus"]
+  "required": ["orderId"]`;

const breakingSchemaFile: ChangedFile = {
  diff: breakingDiff,
  fileName: 'catalog/domains/Orders/services/OrdersService/events/OrderConfirmed/schema.json',
};

export const orderConfirmedBreaking = {
  input: {
    fixture: 'breaking-change-order-confirmed',
    schemaFile: breakingSchemaFile,
  } satisfies BreakingChangesEvalInput,
  breakingExpectation: {
    isBreaking: true,
    mentions: ['orderStatus'],
  } satisfies BreakingChangeExpectation,
  consumersExpectation: {
    requiredConsumerIds: ['NotificationsService'],
    forbiddenConsumerIds: ['OrdersService'],
  } satisfies ConsumersExpectation,
};

/**
 * Non-breaking schema change: the OrderConfirmed schema gains a new OPTIONAL `currency` field.
 * Adding an optional field is additive and does not break existing consumers, so the agent should
 * mark this isBreaking: false. We only run the detect phase for this one.
 */
const additiveDiff = `diff --git a/catalog/domains/Orders/services/OrdersService/events/OrderConfirmed/schema.json b/catalog/domains/Orders/services/OrdersService/events/OrderConfirmed/schema.json
@@
   "properties": {
     "orderId": { "type": "string" },
-    "orderStatus": { "type": "string" }
+    "orderStatus": { "type": "string" },
+    "currency": { "type": "string" }
   },
   "required": ["orderId", "orderStatus"]`;

const additiveSchemaFile: ChangedFile = {
  diff: additiveDiff,
  fileName: 'catalog/domains/Orders/services/OrdersService/events/OrderConfirmed/schema.json',
};

export const orderConfirmedAdditive = {
  input: {
    fixture: 'breaking-change-order-confirmed',
    schemaFile: additiveSchemaFile,
    detectOnly: true,
  } satisfies BreakingChangesEvalInput,
  breakingExpectation: {
    isBreaking: false,
  } satisfies BreakingChangeExpectation,
};
