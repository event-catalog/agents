import type { AgentEvalInput } from '../../support/harness';
import type { ImpactPlanExpectation } from '../../support/scorers';

/**
 * Source PR diff: a brand-new PaymentsService is added with a REST API and an OpenAPI spec
 * (`openapi.yml`). The catalog has a Payments domain but no PaymentsService yet.
 *
 * A correct run creates the new service under the Payments domain, writes the OpenAPI spec file
 * alongside the service, and references it from the service frontmatter (`specifications` /
 * `schemaPath`).
 */
const diff = `diff --git a/src/payments-service/openapi.yml b/src/payments-service/openapi.yml
new file mode 100644
@@
+openapi: 3.0.0
+info:
+  title: Payments Service API
+  version: 1.0.0
+paths:
+  /payments:
+    post: { operationId: createPayment, summary: Create a payment }
+  /payments/{id}:
+    get: { operationId: getPayment, summary: Fetch a payment by id }
diff --git a/src/payments-service/index.js b/src/payments-service/index.js
new file mode 100644
@@
+import express from "express";
+const app = express();
+// New PaymentsService exposing a REST API described by openapi.yml
+app.post("/payments", async (req, res) => res.status(201).json({ id: "pay_123", status: "succeeded" }));
+app.get("/payments/:id", async (req, res) => res.json({ id: req.params.id, status: "succeeded" }));
+export default app;`;

export const newServiceWithOpenapi = {
  input: { fixture: 'new-service-with-openapi', diff } satisfies AgentEvalInput,
  planExpectation: {
    // The new service can live top-level (`services/...`) or nested under the domain
    // (`domains/Payments/services/...`) — both are valid EventCatalog — so we don't pin a path here.
    // The apply assertions check the real files. We only require the change be classified correctly.
    requiredTargets: [],
    forbiddenTargets: ['channels', 'events'],
    requiredSourceChange: { id: 'PaymentsService', type: 'service-added' },
    expectChangesRequired: true,
  } satisfies ImpactPlanExpectation,
  /** The OpenAPI spec must be referenced from the service frontmatter. */
  expectedSpecMarkers: ['openapi'],
};
