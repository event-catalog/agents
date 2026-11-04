import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { ImpactPlanResponse } from '@/src/review-output';
import { archivePreviousVersions, readFrontmatterVersion } from '@/src/utils/archive-versions';
import { getUnauthorizedCatalogChanges } from '@/src/utils/impact-plan';
import { addVersionPinTargets } from '@/src/utils/version-pins';
import { createTempCatalog, type TempCatalog } from './support/temp-catalog';

/**
 * Offline tests for what the workflow does around a version bump, against the
 * `message-version-bump` fixture catalog (OrdersService sends OrderConfirmed 1.0.0, InventoryService
 * receives 1.0.0, BillingService receives `latest`). No model involved.
 */

const EVENT = 'domains/Orders/services/OrdersService/events/OrderConfirmed';
const PRODUCER = 'domains/Orders/services/OrdersService/index.mdx';
const CONSUMER = 'domains/Orders/services/InventoryService/index.mdx';

const planWith = (...paths: string[]): ImpactPlanResponse => ({
  catalogChangesRequired: true,
  sourcePrSummary: '',
  catalogImpactSummary: '',
  sourceChanges: [],
  proposedCatalogTargets: paths.map((path) => ({ action: 'update', path, reason: 'test' })),
  outOfScopeFindings: [],
});

let catalog: TempCatalog;
beforeEach(async () => {
  catalog = await createTempCatalog('message-version-bump');
});
afterEach(async () => {
  await catalog.remove();
});

test('adds the resources that pin a planned message at its current version', async () => {
  const { plan, added } = await addVersionPinTargets(planWith(`${EVENT}/schema.json`), catalog.root, 'catalog');

  expect(added.map((target) => target.path).sort()).toEqual([CONSUMER, PRODUCER]);
  expect(added.every((target) => target.reason.includes('event OrderConfirmed 1.0.0'))).toBe(true);
  // BillingService pins `latest`, so it follows the new version without an edit.
  expect(plan.proposedCatalogTargets.some((target) => target.path.includes('BillingService'))).toBe(false);
});

test('does not add a resource the plan already covers, and ignores unrelated plans', async () => {
  const { added } = await addVersionPinTargets(planWith(`${EVENT}/index.mdx`, PRODUCER), catalog.root, 'catalog');
  expect(added.map((target) => target.path)).toEqual([CONSUMER]);

  const unrelated = await addVersionPinTargets(
    planWith('domains/Orders/services/BillingService/index.mdx'),
    catalog.root,
    'catalog'
  );
  expect(unrelated.added).toEqual([]);
});

test('matches targets written with the catalog folder prefix', async () => {
  const { added } = await addVersionPinTargets(planWith(`catalog/${EVENT}`), catalog.root, 'catalog');
  expect(added).toHaveLength(2);
});

test('archives the previous version when a resource version is bumped', async () => {
  const previousSchema = await catalog.read(`${EVENT}/schema.json`);
  await catalog.edit(`${EVENT}/index.mdx`, (content) => content.replace('version: 1.0.0', 'version: 2.0.0'));
  await catalog.write(`${EVENT}/schema.json`, '{ "title": "OrderConfirmed v2" }\n');

  const archived = await archivePreviousVersions(catalog.root);

  expect(archived).toEqual([{ path: EVENT, version: '1.0.0' }]);
  expect(readFrontmatterVersion(await catalog.read(`${EVENT}/versioned/1.0.0/index.mdx`))).toBe('1.0.0');
  expect(await catalog.read(`${EVENT}/versioned/1.0.0/schema.json`)).toBe(previousSchema);

  // Running again reports the same bump but leaves the existing archive alone.
  await catalog.write(`${EVENT}/versioned/1.0.0/schema.json`, 'kept');
  expect(await archivePreviousVersions(catalog.root)).toEqual([{ path: EVENT, version: '1.0.0' }]);
  expect(await catalog.read(`${EVENT}/versioned/1.0.0/schema.json`)).toBe('kept');
});

test('does not archive anything when no version changed', async () => {
  await catalog.edit(`${EVENT}/index.mdx`, (content) => `${content}\nMore detail about the event.\n`);
  await catalog.edit(PRODUCER, (content) => content.replace('Handles the lifecycle', 'Owns the lifecycle'));

  expect(await archivePreviousVersions(catalog.root)).toEqual([]);
  expect(existsSync(join(catalog.root, EVENT, 'versioned'))).toBe(false);
});

test('only copies the resource’s own files, not nested resources', async () => {
  await catalog.edit(PRODUCER, (content) => content.replace('version: 1.0.0\nsummary', 'version: 1.1.0\nsummary'));

  expect(await archivePreviousVersions(catalog.root)).toEqual([
    { path: 'domains/Orders/services/OrdersService', version: '1.0.0' },
  ]);
  expect(existsSync(join(catalog.root, 'domains/Orders/services/OrdersService/versioned/1.0.0/index.mdx'))).toBe(true);
  expect(existsSync(join(catalog.root, 'domains/Orders/services/OrdersService/versioned/1.0.0/events'))).toBe(false);
});

test('reads quoted and unquoted frontmatter versions', () => {
  expect(readFrontmatterVersion('---\nid: a\nversion: 1.2.3\n---\nbody')).toBe('1.2.3');
  expect(readFrontmatterVersion("---\nversion: '0.0.1'\n---\n")).toBe('0.0.1');
  expect(readFrontmatterVersion('no frontmatter\nversion: 1.0.0')).toBeUndefined();
});

test('the off-plan check accepts archive copies of planned resources only', () => {
  const archived = [
    { path: EVENT, version: '1.0.0' },
    { path: 'domains/Orders/services/BillingService', version: '1.0.0' },
  ];
  const changed = [
    `${EVENT}/index.mdx`,
    `${EVENT}/versioned/`, // git lists a new folder as one entry
    `${EVENT}/versioned/1.0.0/schema.json`,
    'domains/Orders/services/BillingService/versioned/1.0.0/index.mdx',
  ];

  expect(getUnauthorizedCatalogChanges(changed, planWith(`${EVENT}/index.mdx`), 'catalog', archived)).toEqual([
    'domains/Orders/services/BillingService/versioned/1.0.0/index.mdx',
  ]);
  // Without the archive list, the copies are off-plan like any other file.
  expect(getUnauthorizedCatalogChanges(changed, planWith(`${EVENT}/index.mdx`), 'catalog')).toHaveLength(3);
});

test('archives correctly when the catalog is a subfolder of its repository', async () => {
  const nested = await createTempCatalog('message-version-bump', { inSubfolder: true });
  try {
    await nested.edit(`${EVENT}/index.mdx`, (content) => content.replace('version: 1.0.0', 'version: 2.0.0'));
    expect(await archivePreviousVersions(nested.root)).toEqual([{ path: EVENT, version: '1.0.0' }]);
    expect(readFrontmatterVersion(await nested.read(`${EVENT}/versioned/1.0.0/index.mdx`))).toBe('1.0.0');
    expect(existsSync(join(nested.root, EVENT, 'versioned/1.0.0/schema.json'))).toBe(true);
  } finally {
    await nested.remove();
  }
});
