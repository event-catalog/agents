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
          path: '/domains/Orders/services/InventoryService',
          reason: 'Receives OrderConfirmed and depends on this payload.',
        },
      ],
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
  expect(comment).toContain('#### Affected consumers');
  expect(comment).toContain('- `InventoryService` (service, 0.0.2) - Receives OrderConfirmed and depends on this payload.');
  expect(comment).not.toMatch(/^  `{3,}/m);
});
