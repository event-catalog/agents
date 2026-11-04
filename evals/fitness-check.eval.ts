import { afterEach, beforeEach, expect, test } from 'vitest';
import { listFitnessProblems, newFitnessProblems, runFitnessFunctions } from '@/src/tools/fitness-check';
import { childProcessEnv, getCatalogPackageVersion } from '@/src/utils/child-process-env';
import { createTempCatalog, type TempCatalog } from './support/temp-catalog';

/**
 * Offline tests for the fitness_check tool: it runs a catalog's fitness functions in a child process
 * (without the catalog's own node_modules) and separates new problems from pre-existing ones.
 */

const EVENT_DOC = 'domains/Orders/services/OrdersService/events/OrderConfirmed/index.mdx';

let catalog: TempCatalog;
beforeEach(async () => {
  catalog = await createTempCatalog('message-version-bump');
});
afterEach(async () => {
  await catalog.remove();
});

test('runs the catalog’s fitness functions without the catalog installing anything', async () => {
  const report = await runFitnessFunctions(catalog.root);

  expect(report.summary).toMatchObject({ total: 1, passed: 1, failed: 0, errors: 0 });
});

test('reports a problem introduced by an edit, and only that one', async () => {
  const before = listFitnessProblems(await runFitnessFunctions(catalog.root));
  await catalog.edit(EVENT_DOC, (content) => content.replace('version: 1.0.0', 'version: 2.0.0'));
  const after = listFitnessProblems(await runFitnessFunctions(catalog.root));

  expect(newFitnessProblems(before, after)).toEqual([
    expect.objectContaining({
      function: 'producers-send-latest-message-version',
      severity: 'error',
      message: 'Orders Service sends OrderConfirmed 1.0.0, but the latest version is 2.0.0',
    }),
  ]);
  // The same problem already in the baseline is not new.
  expect(newFitnessProblems(after, after)).toEqual([]);
});

test('child processes never see the run’s secrets', () => {
  const saved = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  process.env.EVENTCATALOG_CATALOG_TOKEN = 'ghp_test';
  process.env.GITHUB_TOKEN = 'ghs_test';
  try {
    const env = childProcessEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.EVENTCATALOG_CATALOG_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
  } finally {
    process.env = saved;
  }
});

test('uses the linter version the catalog pins', async () => {
  expect(getCatalogPackageVersion(catalog.root, '@eventcatalog/linter')).toBeUndefined();

  await catalog.write('package.json', JSON.stringify({ devDependencies: { '@eventcatalog/linter': '1.0.29' } }));
  expect(getCatalogPackageVersion(catalog.root, '@eventcatalog/linter')).toBe('1.0.29');

  await catalog.write('package.json', JSON.stringify({ dependencies: { '@eventcatalog/linter': 'latest' } }));
  expect(getCatalogPackageVersion(catalog.root, '@eventcatalog/linter')).toBeUndefined();
});
