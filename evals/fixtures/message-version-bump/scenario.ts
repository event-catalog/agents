import type { AgentEvalInput } from '../../support/harness';
import type { ImpactPlanExpectation } from '../../support/scorers';

/**
 * Source PR diff: a breaking change to OrderConfirmed. `totalAmount` (a number) is replaced by a
 * required `total` object, and the contract version goes from 1.0.0 to 2.0.0. Only the Orders
 * Service (the producer) changes; the Inventory Service still consumes 1.0.0.
 */
const diff = `diff --git a/src/contracts/messages.js b/src/contracts/messages.js
@@
   OrderConfirmed: {
     id: 'OrderConfirmed',
-    version: '1.0.0',
+    version: '2.0.0',
     type: 'io.eventcatalog.orders.event.order-confirmed',
   },
diff --git a/src/orders-service.js b/src/orders-service.js
@@
   async confirmOrder(order) {
-    return this.#publishDomainEvent(messages.OrderConfirmed, { orderId: order.id, totalAmount: order.total });
+    // Breaking: totals are now an object with the amount in minor units and its currency.
+    return this.#publishDomainEvent(messages.OrderConfirmed, {
+      orderId: order.id,
+      total: { amountMinor: order.totalMinor, currency: order.currency },
+    });
   }`;

export const messageVersionBump = {
  input: { fixture: 'message-version-bump', diff } satisfies AgentEvalInput,
  planExpectation: {
    requiredTargets: ['domains/Orders/services/OrdersService/events/OrderConfirmed/schema.json'],
    forbiddenTargets: ['channels', 'domains/Orders/services/BillingService'],
    requiredSourceChange: { id: 'OrderConfirmed', type: 'schema-changed' },
    expectChangesRequired: true,
  } satisfies ImpactPlanExpectation,
  eventFolder: 'domains/Orders/services/OrdersService/events/OrderConfirmed',
  producer: 'domains/Orders/services/OrdersService/index.mdx',
  /** Pins 1.0.0 and isn't changed by the PR, so it should stay on 1.0.0. */
  consumer: 'domains/Orders/services/InventoryService/index.mdx',
  /** Pins `latest`, so it follows the new version without being touched. */
  latestConsumer: 'domains/Orders/services/BillingService/index.mdx',
  previousVersion: '1.0.0',
  newVersion: '2.0.0',
};
