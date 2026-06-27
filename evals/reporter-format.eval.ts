import { expect, test } from 'vitest';
import { formatBreakingChangesComment, type BreakingSchemaReport } from '@/src/utils/github/reporter';

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

  expect(comment).not.toContain('# EventCatalog Breaking Changes');
  expect(comment).toMatch(
    /^<!-- eventcatalog-actions:breaking-changes -->\n### `src\/contracts\/schemas\/order-confirmed\.schema\.json`/
  );
  expect(comment).toContain('**1. Removed the `totalAmount` property from the schema.**');
  expect(comment).toContain('````diff\n```\n- "totalAmount": {');
  expect(comment).toContain('+ "required": ["orderId"]\n```\n````');
  expect(comment).toContain('#### Impact diagram');
  expect(comment).toContain('```mermaid\nflowchart LR');
  expect(comment).toContain('classDef service fill:#fdf2f8,stroke:#ec4899,color:#831843;');
  expect(comment).not.toContain('```mermaid\n```mermaid');
  expect(comment).toContain('#### Affected consumers');
  expect(comment).toContain(
    '- InventoryService (0.0.2) - Keeps inventory in sync with confirmed orders.\n  - Reason: Receives OrderConfirmed and depends on this payload.\n  - Owners: inventory-team'
  );
  expect(comment).not.toContain('| Name | Version | Summary | Owners | Why affected | Path |');
  expect(comment).not.toContain('/domains/Orders/services/InventoryService');
  expect(comment).not.toMatch(/^  `{3,}/m);
});
