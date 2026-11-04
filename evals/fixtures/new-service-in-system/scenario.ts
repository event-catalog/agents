import type { AgentEvalInput } from '../../support/harness';
import type { ImpactPlanExpectation } from '../../support/scorers';

/**
 * Source PR diff: a new RefundWorker service joins the payment-processing system. The Payments domain
 * is organised into systems, so the service belongs inside that system's folder and the system's
 * `services` list must include it (not the domain's).
 */
const diff = `diff --git a/src/refund-worker/index.js b/src/refund-worker/index.js
new file mode 100644
--- /dev/null
+++ b/src/refund-worker/index.js
@@
+// Refund Worker: part of the payment-processing system, alongside the Payment API.
+// Processes refunds for orders against the payment provider.
+export class RefundWorker {
+  constructor(provider) {
+    this.provider = provider;
+  }
+
+  async refund(paymentId, amountMinor) {
+    return this.provider.refund({ paymentId, amountMinor });
+  }
+}`;

export const newServiceInSystem = {
  input: { fixture: 'new-service-in-system', diff } satisfies AgentEvalInput,
  planExpectation: {
    requiredTargets: ['domains/Payments/systems/payment-processing/index.mdx'],
    forbiddenTargets: ['channels', 'domains/Payments/systems/payment-processing/services/PaymentAPI'],
    requiredSourceChange: { id: 'RefundWorker', type: 'service-added' },
    expectChangesRequired: true,
  } satisfies ImpactPlanExpectation,
  systemDoc: 'domains/Payments/systems/payment-processing/index.mdx',
  serviceFolder: 'domains/Payments/systems/payment-processing/services/',
};
