import type { AgentEvalInput } from '../../support/harness';
import type { ImpactPlanExpectation } from '../../support/scorers';

/** Source PR diff: adds an OrderRefunded event published by OrdersService. */
const diff = `diff --git a/src/contracts/messages.js b/src/contracts/messages.js
@@
   OrderConfirmed: {
     id: "OrderConfirmed",
     version: "1.0.0",
     type: "io.eventcatalog.orders.event.order-confirmed",
   },
+  OrderRefunded: {
+    id: "OrderRefunded",
+    version: "0.0.1",
+    type: "io.eventcatalog.orders.event.order-refunded",
+  },
diff --git a/src/orders-service.js b/src/orders-service.js
@@
+  async refundOrder(orderId, reason = "customer refund requested", amount) {
+    return this.#publishDomainEvent(messages.OrderRefunded, {
+      orderId,
+      orderStatus: "refunded",
+      refundAmount: amount,
+      refundReason: reason,
+    });
+  }`;

export const orderRefunded = {
  input: { fixture: 'order-refunded', diff } satisfies AgentEvalInput,
  planExpectation: {
    requiredTargets: [
      'domains/Orders/services/OrdersService/events/OrderRefunded',
      'domains/Orders/services/OrdersService/index.mdx',
    ],
    forbiddenTargets: ['channels'],
    requiredSourceChange: { id: 'OrderRefunded', type: 'event-added' },
    expectChangesRequired: true,
  } satisfies ImpactPlanExpectation,
};
