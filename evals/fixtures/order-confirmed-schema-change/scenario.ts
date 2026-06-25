import type { AgentEvalInput } from '../../support/harness';
import type { ImpactPlanExpectation } from '../../support/scorers';

/**
 * Source PR diff: the OrderConfirmed event gains a new `currency` field on its payload. No new
 * event is added — this is an existing event whose schema changed, so the agent should UPDATE
 * OrderConfirmed's schema.json rather than create anything new.
 */
const diff = `diff --git a/src/orders-service.js b/src/orders-service.js
@@
-  async confirmOrder(orderId) {
-    return this.#publishDomainEvent(messages.OrderConfirmed, { orderId, orderStatus: "confirmed" });
+  async confirmOrder(orderId, currency) {
+    return this.#publishDomainEvent(messages.OrderConfirmed, { orderId, orderStatus: "confirmed", currency });
   }`;

export const orderConfirmedSchemaChange = {
  input: { fixture: 'order-confirmed-schema-change', diff } satisfies AgentEvalInput,
  planExpectation: {
    requiredTargets: ['domains/Orders/services/OrdersService/events/OrderConfirmed/schema.json'],
    forbiddenTargets: ['channels', 'events/OrderRefunded'],
    requiredSourceChange: { id: 'OrderConfirmed', type: 'schema-changed' },
    expectChangesRequired: true,
  } satisfies ImpactPlanExpectation,
  /** The new property the schema must gain after the agent applies the change. */
  expectedSchemaProperty: 'currency',
};
