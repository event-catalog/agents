import { expect, test } from 'vitest';
import type { ImpactPlanResponse } from '@/src/review-output';
import type { ResourceChange } from '@/src/utils/catalog-changes';
import { formatCatalogPullRequestBody } from '@/src/utils/github/catalog-pr';
import { nestHeadings } from '@/src/utils/github/format';
import { formatBreakingChangesComment, formatReviewComment, type BreakingSchemaReport } from '@/src/utils/github/reporter';

test('formats breaking-change diff snippets as top-level fenced code blocks', () => {
  const reports: BreakingSchemaReport[] = [
    {
      breakingChange: {
        fileName: 'src/contracts/schemas/order-confirmed.schema.json',
        isBreaking: true,
        confidence: 'high',
        summary: 'Removing `totalAmount` alters the contract.',
        breakingChanges: [
          {
            change: 'Removed the `totalAmount` property from the schema.',
            lines: [
              '```',
              '- "totalAmount": {',
              '-   "type": "number",',
              '-   "description": "Total monetary amount of the order."',
              '- },',
              '- "required": ["orderId", "totalAmount"]',
              '+ "required": ["orderId"]',
              '```',
            ].join('\n'),
          },
        ],
      },
      consumers: [
        {
          id: 'InventoryService',
          version: '0.0.2',
          type: 'service',
          summary: 'Keeps inventory in sync with confirmed orders.',
          owners: ['inventory-team'],
          path: '/domains/Orders/services/InventoryService',
          reason: 'Receives OrderConfirmed and depends on this payload.',
        },
      ],
      diagram: [
        '```mermaid',
        'flowchart LR',
        '  OrdersService[OrdersService] -- sends --> OrderConfirmed[OrderConfirmed]',
        '  OrderConfirmed -- received by --> InventoryService[InventoryService]',
        '  classDef service fill:#fdf2f8,stroke:#ec4899,color:#831843;',
        '  classDef event fill:#fff7ed,stroke:#f97316,color:#9a3412;',
        '  class OrdersService,InventoryService service;',
        '  class OrderConfirmed event;',
        '```',
      ].join('\n'),
    },
  ];

  const comment = formatBreakingChangesComment(reports);

  expect(comment).toMatch(/^<!-- eventcatalog-actions:breaking-changes -->\n### ⚠️ Breaking schema changes\n/);
  expect(comment).toContain(
    'This pull request makes breaking changes to 1 schema used by 1 consumer documented in EventCatalog. Check with their owners before merging.'
  );
  expect(comment).toContain('#### `src/contracts/schemas/order-confirmed.schema.json`');
  expect(comment).toContain('**1. Removed the `totalAmount` property from the schema.**');
  expect(comment).toContain('````diff\n```\n- "totalAmount": {');
  expect(comment).toContain('+ "required": ["orderId"]\n```\n````');
  expect(comment).toContain('**Impact diagram**');
  expect(comment).toContain('```mermaid\nflowchart LR');
  expect(comment).toContain('classDef service fill:#fdf2f8,stroke:#ec4899,color:#831843;');
  expect(comment).not.toContain('```mermaid\n```mermaid');
  expect(comment).toContain('**Affected consumers**');
  expect(comment).toContain(
    '- InventoryService (0.0.2) - Keeps inventory in sync with confirmed orders.\n  - Reason: Receives OrderConfirmed and depends on this payload.\n  - Owners: inventory-team'
  );
  expect(comment).not.toContain('https://catalog.example.com/docs/services/InventoryService/0.0.2');
  expect(comment).not.toContain('https://catalog.example.com/docs/teams/inventory-team');
  expect(comment).not.toContain('| Name | Version | Summary | Owners | Why affected | Path |');
  expect(comment).not.toContain('/domains/Orders/services/InventoryService');
  expect(comment).not.toMatch(/^  `{3,}/m);
});

test('links affected consumers and owners when a hosted catalog URL is configured', () => {
  const reports: BreakingSchemaReport[] = [
    {
      breakingChange: {
        fileName: 'src/contracts/schemas/create-order.schema.json',
        isBreaking: true,
        confidence: 'high',
        summary: 'Changing totals makes existing create-order payloads invalid.',
        breakingChanges: [
          {
            change: 'Changed `total` to required `totals` object.',
            lines: '+ \"totals\": { \"type\": \"object\" }',
          },
        ],
      },
      consumers: [
        {
          id: 'order-service',
          version: '1.0.0',
          type: 'service',
          summary: 'The system of record for orders.',
          owners: ['ordering-platform'],
          path: 'domains/Orders/services/order-service',
          reason: 'Receives the create-order command.',
        },
      ],
      diagram: '',
    },
  ];

  const comment = formatBreakingChangesComment(reports, 'https://demo.eventcatalog.dev/');

  expect(comment).toContain(
    '- [order-service](https://demo.eventcatalog.dev/docs/services/order-service/1.0.0) (1.0.0) - The system of record for orders.'
  );
  expect(comment).toContain('- Owners: [ordering-platform](https://demo.eventcatalog.dev/docs/teams/ordering-platform)');
});

test('adds a Mermaid flowchart declaration when the model omits it', () => {
  const reports: BreakingSchemaReport[] = [
    {
      breakingChange: {
        fileName: 'src/contracts/schemas/create-order.schema.json',
        isBreaking: true,
        confidence: 'high',
        summary: 'The create-order command changed shape.',
        breakingChanges: [
          {
            change: 'Changed `total` to `totals`.',
            lines: '+ \"totals\": { \"type\": \"object\" }',
          },
        ],
      },
      consumers: [],
      diagram: [
        'classDef service fill:#fdf2f8,stroke:#ec4899,color:#9a3412;',
        'classDef command fill:#e0f2fe,stroke:#3b82f6,color:#1e3a8a;',
        'CheckoutOrchestrator service;',
        'CreateOrder command;',
        'OrderService service;',
        'CheckoutOrchestrator -- sends --> CreateOrder;',
        'CreateOrder -- receives --> OrderService;',
      ].join('\n'),
    },
  ];

  const comment = formatBreakingChangesComment(reports);

  expect(comment).toContain('```mermaid\nflowchart LR\nclassDef service');
});

test('says when a breaking change has no documented consumers', () => {
  const comment = formatBreakingChangesComment([
    {
      breakingChange: {
        fileName: 'schemas/a.json',
        isBreaking: true,
        confidence: 'high',
        summary: 'Removed a field.',
        breakingChanges: [{ change: 'Removed `a`.', lines: '- "a": {}' }],
      },
      consumers: [],
    },
  ]);

  expect(comment).toContain('This pull request makes breaking changes to 1 schema. EventCatalog documents no consumers for it.');
});

const plan: ImpactPlanResponse = {
  catalogChangesRequired: true,
  sourcePrSummary: 'Adds account closure to the Customer API.',
  catalogImpactSummary: 'A new CustomerClosed event needs documenting, and CustomerAPI now sends it.',
  sourceChanges: [
    { confidence: 'high', description: 'New CustomerClosed event.', evidence: [], id: 'CustomerClosed', type: 'event-added' },
    {
      confidence: 'medium',
      description: 'DELETE endpoint modelled as a command.',
      evidence: [],
      id: 'CloseCustomer',
      type: 'command-added',
    },
  ],
  proposedCatalogTargets: [
    { action: 'create', path: 'domains/Customer/services/CustomerAPI/events/CustomerClosed', reason: 'New event.' },
    { action: 'update', path: 'domains/Customer/services/CustomerAPI/index.mdx', reason: 'Sends the new event.' },
  ],
  outOfScopeFindings: ['CustomerUpdated has no consumers.'],
};

const changes: ResourceChange[] = [
  {
    action: 'updated',
    type: 'service',
    name: 'CustomerAPI',
    path: 'domains/Customer/services/CustomerAPI',
    files: ['index.mdx', 'openapi.yml'],
    archivedVersions: [],
  },
  {
    action: 'added',
    type: 'event',
    name: 'CustomerClosed',
    path: 'domains/Customer/services/CustomerAPI/events/CustomerClosed',
    files: ['index.mdx', 'schema.json'],
    archivedVersions: [],
  },
];

const context = { catalogRepo: 'acme/catalog', catalogRef: 'main' };

test('a catalog update leads with the catalog PR and what changed in the catalog', () => {
  const comment = formatReviewComment(
    {
      kind: 'catalog-updated',
      catalogPullRequestUrl: 'https://github.com/acme/catalog/pull/21',
      changes,
      impactPlan: plan,
      reviewedFiles: 7,
    },
    context
  );

  expect(comment).toMatch(/^<!-- eventcatalog-actions:pr-review -->\n### 📘 EventCatalog docs updated\n/);
  expect(comment).toContain('Opened [acme/catalog#21](https://github.com/acme/catalog/pull/21) to keep the catalog in sync');
  // Added rows come first.
  expect(comment).toContain(
    '| Change | Resource | Files |\n| --- | --- | --- |\n| Added | Event `CustomerClosed` | `index.mdx`, `schema.json` |\n| Updated | Service `CustomerAPI` | `index.mdx`, `openapi.yml` |'
  );
  expect(comment).toContain('- Not fully sure (medium confidence): DELETE endpoint modelled as a command.');
  expect(comment).toContain('- Noticed in the catalog but not changed: CustomerUpdated has no consumers.');
  expect(comment).toContain(
    '<sub>EventCatalog Agents · Code-to-Docs · reviewed 7 changed files · catalog [acme/catalog@main](https://github.com/acme/catalog/tree/main)</sub>'
  );
  // The source PR's own summary and file list are not repeated back to its author.
  expect(comment).not.toContain(plan.sourcePrSummary);
  expect(comment).not.toContain('Files Reviewed');
});

test('a no-op explains what the change means for the catalog', () => {
  const comment = formatReviewComment(
    { kind: 'no-changes', impactPlan: { ...plan, outOfScopeFindings: [], sourceChanges: [] }, reviewedFiles: 1 },
    context
  );

  expect(comment).toContain('### 📘 No EventCatalog changes needed\n\nA new CustomerClosed event needs documenting');
  expect(comment).not.toContain('Worth checking');
  expect(comment).toContain('reviewed 1 changed file ·');
});

test('an off-plan run lists what was planned, what was edited, and what to do next', () => {
  const comment = formatReviewComment(
    {
      kind: 'off-plan',
      impactPlan: plan,
      unauthorizedChanges: ['domains/Payments/services/PaymentWorker/index.mdx'],
      reviewedFiles: 5,
    },
    context
  );

  expect(comment).toContain('### ⚠️ EventCatalog docs not updated');
  expect(comment).toContain('- `domains/Customer/services/CustomerAPI/events/CustomerClosed` (create)');
  expect(comment).toContain('**Edited outside the plan**\n\n- `domains/Payments/services/PaymentWorker/index.mdx`');
  expect(comment).toContain('**Next step:** re-run this workflow');
});

test('a run that could not start gives the reason and the fix', () => {
  const comment = formatReviewComment(
    {
      kind: 'not-run',
      reason: "The agent couldn't access the catalog repository: Bad credentials",
      nextStep: 'Check the token.',
    },
    context
  );

  expect(comment).toContain(
    "### ⏭️ EventCatalog docs not checked\n\nThe agent couldn't access the catalog repository: Bad credentials"
  );
  expect(comment).toContain('**Next step:** Check the token.');
  expect(comment).toContain('<sub>EventCatalog Agents · Code-to-Docs · catalog [acme/catalog@main]');
});

test('the catalog PR body links the source PR first and nests the model summary under its own heading', () => {
  const body = formatCatalogPullRequestBody(
    { github: { owner: 'acme', repo: 'shop', prNumber: 12, token: 't' } },
    [{ ...changes[1], action: 'updated', archivedVersions: ['1.0.0'] }],
    {
      impactPlan: plan,
      result: {
        prTitle: 'docs: add CustomerClosed',
        prSummary: '## What changed\n\nAdded the event.\n\n```yaml\n# not a heading\n```',
        sourcePrSummary: '',
      },
    }
  );

  expect(body).toMatch(
    /^> \[!NOTE\]\n> Opened by \[EventCatalog Agents\]\(https:\/\/github\.com\/event-catalog\/agents\) for \[acme\/shop#12\]/
  );
  expect(body).toContain('| Updated | Event `CustomerClosed` | `index.mdx`, `schema.json`, previous version `1.0.0` archived |');
  expect(body).toContain('## Summary\n\n### What changed\n\nAdded the event.');
  expect(body).toContain('```yaml\n# not a heading\n```');
  expect(body).toContain('## Worth checking\n\n- Not fully sure (medium confidence)');
  expect(body).not.toContain('Catalog Files Changed');
});

test('nestHeadings shifts headings to the requested level and leaves code alone', () => {
  expect(nestHeadings('# A\n## B\ntext', 3)).toBe('### A\n#### B\ntext');
  expect(nestHeadings('#### Already deep', 3)).toBe('#### Already deep');
  expect(nestHeadings('no headings', 3)).toBe('no headings');
});
