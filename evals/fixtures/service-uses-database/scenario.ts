import type { AgentEvalInput } from '../../support/harness';
import type { ImpactPlanExpectation } from '../../support/scorers';

/**
 * Source PR diff: OrdersService now connects to a Postgres `orders-db` — it both writes orders to it
 * and reads them back (readWrite). The catalog has no container documented for OrdersService yet, so
 * the agent should create a new container (data store) under the service and map the service's
 * readsFrom/writesTo to it.
 */
const diff = `diff --git a/src/orders-service.js b/src/orders-service.js
@@
+import { Pool } from "pg";
+
 export class OrdersService {
+  // Connects to the orders Postgres database (system of record for orders).
+  #db = new Pool({ connectionString: process.env.ORDERS_DATABASE_URL });
+
   async confirmOrder(orderId) {
-    return { orderId, orderStatus: "confirmed" };
+    // Persist the confirmation, then read the stored order back.
+    await this.#db.query("UPDATE orders SET status = 'confirmed' WHERE id = $1", [orderId]);
+    const { rows } = await this.#db.query("SELECT id, status FROM orders WHERE id = $1", [orderId]);
+    return rows[0];
   }
 }`;

export const serviceUsesDatabase = {
  input: { fixture: 'service-uses-database', diff } satisfies AgentEvalInput,
  planExpectation: {
    // The new container lives under the service: services/OrdersService/containers/<db>.
    requiredTargets: ['domains/Orders/services/OrdersService/containers', 'domains/Orders/services/OrdersService/index.mdx'],
    forbiddenTargets: ['channels', 'events'],
    requiredSourceChange: { id: 'OrdersService', type: 'service-changed' },
    expectChangesRequired: true,
  } satisfies ImpactPlanExpectation,
  /** The service must end up mapped to the database for both reads and writes. */
  expectedServiceFields: ['writesTo', 'readsFrom'],
};
