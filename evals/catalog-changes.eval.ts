import { expect, test } from 'vitest';
import { describeCatalogChanges } from '@/src/utils/catalog-changes';
import { getUnauthorizedCatalogChanges, isFitnessFunctionFile } from '@/src/utils/impact-plan';
import type { ImpactPlanResponse } from '@/src/review-output';

/**
 * Offline tests for how changed catalog files are summarised per resource (used by the source PR
 * comment and the catalog PR body), and for the off-plan rule that fitness functions are never the
 * agent's to change. No model involved.
 */

test('groups changed files by the resource they belong to', () => {
  const changes = describeCatalogChanges([
    { path: 'domains/Customer/services/CustomerAPI/events/CustomerClosed/index.mdx', status: 'added' },
    { path: 'domains/Customer/services/CustomerAPI/events/CustomerClosed/schema.json', status: 'added' },
    { path: 'domains/Customer/services/CustomerAPI/index.mdx', status: 'modified' },
    { path: 'domains/Customer/services/CustomerAPI/openapi.yml', status: 'modified' },
  ]);

  expect(changes).toEqual([
    {
      action: 'added',
      type: 'event',
      name: 'CustomerClosed',
      path: 'domains/Customer/services/CustomerAPI/events/CustomerClosed',
      files: ['index.mdx', 'schema.json'],
      archivedVersions: [],
    },
    {
      action: 'updated',
      type: 'service',
      name: 'CustomerAPI',
      path: 'domains/Customer/services/CustomerAPI',
      files: ['index.mdx', 'openapi.yml'],
      archivedVersions: [],
    },
  ]);
});

test('reports archived versions on the resource that holds them, not as files', () => {
  const [event] = describeCatalogChanges([
    { path: 'domains/Orders/events/OrderConfirmed/index.mdx', status: 'modified' },
    { path: 'domains/Orders/events/OrderConfirmed/versioned/1.0.0/index.mdx', status: 'added' },
    { path: 'domains/Orders/events/OrderConfirmed/versioned/1.0.0/schema.json', status: 'added' },
  ]);

  expect(event).toMatchObject({
    action: 'updated',
    type: 'event',
    name: 'OrderConfirmed',
    files: ['index.mdx'],
    archivedVersions: ['1.0.0'],
  });
});

test('a new extra page in a domain updates it rather than adding it', () => {
  const [domain] = describeCatalogChanges([{ path: 'domains/Customer/ubiquitous-language.mdx', status: 'added' }]);
  expect(domain).toMatchObject({ action: 'updated', type: 'domain', name: 'Customer' });
});

test('handles teams, removed resources, data stores and files outside any resource', () => {
  const changes = describeCatalogChanges([
    { path: 'teams/orders-team.mdx', status: 'added' },
    { path: 'domains/Orders/services/OrdersService/events/OrderShipped/index.mdx', status: 'deleted' },
    { path: 'domains/Orders/services/OrdersService/events/OrderShipped/schema.json', status: 'deleted' },
    { path: 'domains/Orders/systems/orders/containers/orders-db/index.mdx', status: 'added' },
    { path: 'eventcatalog.config.js', status: 'modified' },
  ]);

  expect(changes.map(({ action, type, name }) => `${action} ${type} ${name}`)).toEqual([
    'added team orders-team',
    'removed event OrderShipped',
    'added data store orders-db',
    'updated file eventcatalog.config.js',
  ]);
});

test('fitness functions are never authorized, even inside an approved target', () => {
  const plan = {
    proposedCatalogTargets: [{ action: 'update', path: 'domains/Orders', reason: 'The Orders domain changed.' }],
  } as ImpactPlanResponse;

  expect(isFitnessFunctionFile('fitness/rules.fitness.ts')).toBe(true);
  expect(isFitnessFunctionFile('domains/Orders/fitness/helpers.ts')).toBe(true);
  expect(isFitnessFunctionFile('domains/Orders/index.mdx')).toBe(false);
  expect(
    getUnauthorizedCatalogChanges(
      ['domains/Orders/index.mdx', 'domains/Orders/fitness/boundaries.fitness.ts', 'domains/Orders/rules.fitness.ts'],
      plan,
      'eventcatalog'
    )
  ).toEqual(['domains/Orders/fitness/boundaries.fitness.ts', 'domains/Orders/rules.fitness.ts']);
});
