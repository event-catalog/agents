import type { AgentEvalInput } from '../../support/harness';
import type { ImpactPlanExpectation } from '../../support/scorers';

/**
 * Source PR diff: OrdersService starts publishing a new OrderConfirmed event onto a Kafka topic
 * (`orders.confirmed`). The catalog documents OrdersService but has no events or channels yet.
 *
 * A correct run documents three things: the new event, a channel representing the Kafka topic, and
 * the service sending the event TO that channel (sends[].to references the channel).
 */
const diff = `diff --git a/src/contracts/messages.js b/src/contracts/messages.js
new file mode 100644
@@
+export const messages = {
+  OrderConfirmed: {
+    id: "OrderConfirmed",
+    version: "1.0.0",
+    type: "io.eventcatalog.orders.event.order-confirmed",
+  },
+};
diff --git a/src/orders-service.js b/src/orders-service.js
@@
+import { Kafka } from "kafkajs";
+import { messages } from "./contracts/messages.js";
+
 export class OrdersService {
+  #producer = new Kafka({ brokers: [process.env.KAFKA_BROKER] }).producer();
+
   async confirmOrder(orderId) {
-    return { orderId, orderStatus: "confirmed" };
+    const event = { orderId, orderStatus: "confirmed" };
+    // Publish OrderConfirmed onto the Kafka "orders.confirmed" topic.
+    await this.#producer.send({
+      topic: "orders.confirmed",
+      messages: [{ key: orderId, value: JSON.stringify({ type: messages.OrderConfirmed.type, data: event }) }],
+    });
+    return event;
   }
 }`;

export const servicePublishesOverKafka = {
  input: { fixture: 'service-publishes-over-kafka', diff } satisfies AgentEvalInput,
  planExpectation: {
    // Only require the service update here. The event and channel can be filed in several valid
    // places (event under the service OR the domain; channel top-level OR nested), so we assert
    // those concretely in the apply phase rather than pinning plan paths. We also don't pin the
    // source-change type: a new event published by a changed service is reasonably labelled either
    // `event-added` or `service-changed`, and the apply checks confirm the event was documented.
    requiredTargets: ['domains/Orders/services/OrdersService/index.mdx'],
    forbiddenTargets: [],
    expectChangesRequired: true,
  } satisfies ImpactPlanExpectation,
  /** The channel doc should declare the kafka protocol. */
  expectedChannelProtocol: 'kafka',
};
