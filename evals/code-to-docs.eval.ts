import { afterAll, expect } from 'vitest';
import { describeEval } from 'vitest-evals';
import { codeToDocsHarness, shouldSkipLiveModelEval } from './support/harness';
import type { AgentEvalOutput } from './support/harness';
import { reportRun } from './support/report';
import { stopFlueRuntime } from './support/flue-runtime';
import { scoreImpactPlan, type ImpactPlanExpectation } from './support/scorers';
import { orderRefunded } from './fixtures/order-refunded/scenario';
import { orderConfirmedSchemaChange } from './fixtures/order-confirmed-schema-change/scenario';
import { serviceUsesDatabase } from './fixtures/service-uses-database/scenario';
import { servicePublishesOverKafka } from './fixtures/service-publishes-over-kafka/scenario';
import { newServiceWithOpenapi } from './fixtures/new-service-with-openapi/scenario';
import { messageVersionBump } from './fixtures/message-version-bump/scenario';
import { newServiceInSystem } from './fixtures/new-service-in-system/scenario';
import { readFrontmatterVersion } from '@/src/utils/archive-versions';

/**
 * Each test runs the REAL code-to-docs agent (real model, tools, and skill) against a fixture ONCE
 * and checks both halves of that single run: the impact plan it proposed AND the files it actually
 * wrote. One agent run per scenario (not one per assertion) keeps token cost and wall-clock down.
 *
 * Live tests skip when no model API key is set (see `skipIf`).
 */

/** Score the plan and fail with the specific rubric failures if it's not perfect. */
const expectGoodPlan = (output: AgentEvalOutput, expectation: ImpactPlanExpectation): void => {
  const { score, failures } = scoreImpactPlan(output.impactPlan, expectation);
  // On failure, show what the agent actually proposed so you don't have to dig through logs.
  const proposed = output.impactPlan.proposedCatalogTargets.map((t) => `  ${t.action} ${t.path}`).join('\n');
  const detail = `${failures.join('\n')}\n\nThe agent proposed:\n${proposed || '  (nothing)'}`;
  expect(failures, detail).toEqual([]);
  expect(score).toBe(1);
};

/** No catalog files were edited outside the approved plan. */
const expectNoUnauthorizedEdits = (output: AgentEvalOutput): void => {
  expect(output.unauthorizedChanges, `Edited files outside the approved plan: ${output.unauthorizedChanges.join(', ')}`).toEqual(
    []
  );
};

const changedList = (output: AgentEvalOutput): string => output.catalogChanges.map((c) => `${c.status} ${c.path}`).join('\n');

afterAll(stopFlueRuntime);

describeEval(
  'code-to-docs agent: turning source-code PRs into EventCatalog documentation',
  { harness: codeToDocsHarness, skipIf: shouldSkipLiveModelEval },
  (it) => {
    it('documents a brand-new event: plans it, then writes the event doc + schema and nothing else', async ({ run }) => {
      const { output } = await run(orderRefunded.input);
      reportRun(output);

      // Plan: identifies the new event and the publishing service to update.
      expectGoodPlan(output, orderRefunded.planExpectation);

      // Apply: wrote the event doc and its schema, only inside the approved plan.
      const wrote = (suffix: string) =>
        output.catalogChanges.some((c) => c.path.includes('OrderRefunded') && c.path.endsWith(suffix));
      expectNoUnauthorizedEdits(output);
      expect(wrote('index.mdx'), `Expected OrderRefunded/index.mdx. Catalog changes were:\n${changedList(output)}`).toBe(true);
      expect(wrote('schema.json'), `Expected OrderRefunded/schema.json. Catalog changes were:\n${changedList(output)}`).toBe(
        true
      );
      expect(output.applyResult?.prTitle).toBeTruthy();
      expect(output.applyResult?.prSummary).toBeTruthy();
    });

    it('updates an existing event whose payload changed: plans the schema update, then adds the new field', async ({ run }) => {
      const { output } = await run(orderConfirmedSchemaChange.input);
      reportRun(output);

      // Plan: classifies it as a schema change to the existing event (nothing new).
      expectGoodPlan(output, orderConfirmedSchemaChange.planExpectation);

      // Apply: the existing schema.json was updated to include the new field.
      const schema = output.catalogChanges.find((c) => c.path.includes('OrderConfirmed') && c.path.endsWith('schema.json'));
      expectNoUnauthorizedEdits(output);
      expect(
        schema,
        `Expected OrderConfirmed/schema.json to be updated. Catalog changes were:\n${changedList(output)}`
      ).toBeDefined();
      expect(
        schema?.content?.includes(orderConfirmedSchemaChange.expectedSchemaProperty),
        `Expected the updated schema to include "${orderConfirmedSchemaChange.expectedSchemaProperty}". Got:\n${schema?.content}`
      ).toBe(true);
    });

    it('documents a service that starts using a database: plans a container, then creates it and maps the service read/write', async ({
      run,
    }) => {
      const { output } = await run(serviceUsesDatabase.input);
      reportRun(output);

      // Plan: a new container under the service, plus the service update.
      expectGoodPlan(output, serviceUsesDatabase.planExpectation);

      // Apply: a container was created with a container_type...
      const container = output.catalogChanges.find((c) => /(^|\/)containers\//.test(c.path) && c.path.endsWith('index.mdx'));
      expectNoUnauthorizedEdits(output);
      expect(container, `Expected a container under the service. Catalog changes were:\n${changedList(output)}`).toBeDefined();
      expect(
        container?.content?.includes('container_type'),
        `Expected the container to declare container_type. Got:\n${container?.content}`
      ).toBe(true);

      // ...and the service was mapped to it for both reads and writes.
      const service = output.catalogChanges.find((c) => c.path.endsWith('OrdersService/index.mdx'));
      expect(
        service,
        `Expected OrdersService/index.mdx to be updated. Catalog changes were:\n${changedList(output)}`
      ).toBeDefined();
      for (const field of serviceUsesDatabase.expectedServiceFields) {
        expect(service?.content?.includes(field), `Expected OrdersService to declare "${field}". Got:\n${service?.content}`).toBe(
          true
        );
      }
    });

    it('documents a service that starts publishing an event over Kafka: creates the event + a kafka channel and sends the event to it', async ({
      run,
    }) => {
      const { output } = await run(servicePublishesOverKafka.input);
      reportRun(output);

      // Plan: identifies the new event and the service to update.
      expectGoodPlan(output, servicePublishesOverKafka.planExpectation);
      expectNoUnauthorizedEdits(output);

      // Apply: the new event was created.
      expect(
        output.catalogChanges.some((c) => c.path.includes('OrderConfirmed') && c.path.endsWith('index.mdx')),
        `Expected an OrderConfirmed event doc. Catalog changes were:\n${changedList(output)}`
      ).toBe(true);

      // Apply: a channel was created — either top-level (`channels/...`) or nested under the service
      // (`.../services/X/channels/...`) — declaring the kafka protocol.
      const channel = output.catalogChanges.find((c) => /(^|\/)channels\//.test(c.path) && c.path.endsWith('index.mdx'));
      expect(channel, `Expected a channel to be created. Catalog changes were:\n${changedList(output)}`).toBeDefined();
      expect(
        channel?.content?.includes(servicePublishesOverKafka.expectedChannelProtocol),
        `Expected the channel to declare the "${servicePublishesOverKafka.expectedChannelProtocol}" protocol. Got:\n${channel?.content}`
      ).toBe(true);

      // Apply: the service sends the event TO the channel (sends[].to references it).
      const service = output.catalogChanges.find((c) => c.path.endsWith('OrdersService/index.mdx'));
      expect(
        service,
        `Expected OrdersService/index.mdx to be updated. Catalog changes were:\n${changedList(output)}`
      ).toBeDefined();
      expect(service?.content?.includes('sends'), `Expected OrdersService to declare sends. Got:\n${service?.content}`).toBe(
        true
      );
      expect(
        service?.content?.includes('to:'),
        `Expected OrdersService sends[].to referencing the channel. Got:\n${service?.content}`
      ).toBe(true);
    });

    it('documents a new service from its OpenAPI spec: creates the service, stores the spec file, and references it', async ({
      run,
    }) => {
      const { output } = await run(newServiceWithOpenapi.input);
      reportRun(output);

      // Plan: a new service added (location and file form are the agent's choice).
      expectGoodPlan(output, newServiceWithOpenapi.planExpectation);
      expectNoUnauthorizedEdits(output);

      // Apply: the new PaymentsService doc was created — anywhere (top-level `services/` or nested
      // under the domain) and in any form (`PaymentsService/index.mdx` or `payments-service.mdx`).
      const isPaymentsService = (path: string) =>
        /payments-?service/i.test(path) && path.endsWith('.mdx') && /(^|\/)services\//.test(path);
      const service = output.catalogChanges.find((c) => isPaymentsService(c.path));
      expect(service, `Expected a PaymentsService doc. Catalog changes were:\n${changedList(output)}`).toBeDefined();

      // Apply: the OpenAPI spec file was written to the catalog.
      const spec = output.catalogChanges.find((c) => /\.(ya?ml|json)$/.test(c.path) && !c.path.endsWith('schema.json'));
      expect(spec, `Expected the OpenAPI spec file to be written. Catalog changes were:\n${changedList(output)}`).toBeDefined();

      // Apply: the service frontmatter references the spec (specifications / schemaPath).
      const referencesSpec = newServiceWithOpenapi.expectedSpecMarkers.every((m) => service?.content?.includes(m));
      expect(
        referencesSpec,
        `Expected the service to reference its OpenAPI spec (specifications/schemaPath). Got:\n${service?.content}`
      ).toBe(true);
    });

    it('bumps a message for a breaking change: updates the producer pin, leaves consumers, and archives the old version', async ({
      run,
    }) => {
      const { output } = await run(messageVersionBump.input);
      reportRun(output);
      const s = messageVersionBump;
      const changed = (path: string) => output.catalogChanges.find((c) => c.path === path);

      // Plan: a schema change to the existing event.
      expectGoodPlan(output, s.planExpectation);

      // The workflow pre-approved the resources that pin 1.0.0, so updating them is not off-plan.
      expectNoUnauthorizedEdits(output);

      // Apply: the schema has the new shape and the event moved to 2.0.0.
      const schema = changed(`${s.eventFolder}/schema.json`);
      expect(
        schema?.content,
        `Expected OrderConfirmed/schema.json to change. Catalog changes were:\n${changedList(output)}`
      ).toContain('"total"');
      const eventDoc = changed(`${s.eventFolder}/index.mdx`);
      expect(
        readFrontmatterVersion(eventDoc?.content ?? ''),
        `Expected OrderConfirmed to be bumped. Got:\n${eventDoc?.content}`
      ).toBe(s.newVersion);

      // Apply: the producer now sends 2.0.0; the untouched consumers keep their pins.
      expect(changed(s.producer)?.content, `Expected OrdersService to send ${s.newVersion}`).toMatch(
        new RegExp(`id: OrderConfirmed\\s*\\n\\s*version: ['"]?${s.newVersion.replaceAll('.', '\\.')}`)
      );
      const consumer = changed(s.consumer);
      expect(consumer?.content ?? 'unchanged', 'InventoryService is not changed by the PR, so it stays on 1.0.0').not.toContain(
        `version: ${s.newVersion}`
      );
      expect(changed(s.latestConsumer), 'BillingService pins latest and should not be edited').toBeUndefined();

      // The workflow archived 1.0.0 under versioned/.
      expect(output.archivedVersions).toEqual([{ path: s.eventFolder, version: s.previousVersion }]);
      expect(changed(`${s.eventFolder}/versioned/${s.previousVersion}/index.mdx`)).toBeDefined();

      // The agent checked its work against the catalog's fitness functions.
      expect(output.toolCalls.map((call) => call.name)).toContain('fitness_check');
    });

    it('adds a new service to a domain organised into systems: nests it in the system and lists it there', async ({ run }) => {
      const { output } = await run(newServiceInSystem.input);
      reportRun(output);
      const s = newServiceInSystem;

      expectGoodPlan(output, s.planExpectation);
      expectNoUnauthorizedEdits(output);

      // Apply: the service doc was created inside the system.
      const service = output.catalogChanges.find(
        (c) => c.status === 'added' && c.path.startsWith(s.serviceFolder) && /refund/i.test(c.path) && c.path.endsWith('.mdx')
      );
      expect(
        service,
        `Expected a RefundWorker service inside the system. Catalog changes were:\n${changedList(output)}`
      ).toBeDefined();

      // Apply: the system lists the new service.
      const system = output.catalogChanges.find((c) => c.path === s.systemDoc);
      expect(
        system?.content,
        `Expected the system to list the new service. Catalog changes were:\n${changedList(output)}`
      ).toMatch(/services:[\s\S]*refund/i);
    });
  }
);
