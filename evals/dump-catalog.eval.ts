import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createDumpCatalogTool } from '@/src/tools/dump-catalog';

/** Offline test: the dump_catalog index includes EventCatalog 5 systems (with their contents) and ADRs. */

const files: Record<string, string> = {
  'domains/Shopping/index.mdx': '---\nid: shopping\nname: Shopping\nversion: 1.0.0\nsystems:\n  - id: cart-system\n---\n',
  'domains/Shopping/systems/cart-system/index.mdx':
    '---\nid: cart-system\nname: Cart System\nversion: 1.0.0\nsummary: Owns the cart.\nowners:\n  - shopping-team\nservices:\n  - id: cart-api\ncontainers:\n  - id: cart-database\n---\n',
  'domains/Shopping/systems/cart-system/services/CartAPI/index.mdx': '---\nid: cart-api\nname: Cart API\nversion: 1.0.0\n---\n',
  'domains/Shopping/systems/cart-system/containers/cart-database/index.mdx':
    '---\nid: cart-database\nname: Cart Database\nversion: 1.0.0\ncontainer_type: database\n---\n',
  'adrs/use-kafka/index.mdx': '---\nid: use-kafka\nname: Use Kafka\nversion: 1.0.0\nstatus: accepted\n---\n',
};

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ec-dump-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test('indexes systems with the services and data stores they contain', async () => {
  const tool = createDumpCatalogTool(root) as unknown as {
    run: (context: object) => Promise<{ output: { resources: Array<Record<string, unknown>>; counts: Record<string, number> } }>;
  };
  const { output } = await tool.run({});

  expect(output.resources.find((resource) => resource.type === 'system')).toMatchObject({
    id: 'cart-system',
    path: '/domains/Shopping/systems/cart-system',
    owners: ['shopping-team'],
    services: ['cart-api'],
    containers: ['cart-database'],
  });
  expect(output.resources.find((resource) => resource.id === 'cart-api')).not.toHaveProperty('services');
  expect(output.counts).toMatchObject({ domain: 1, system: 1, service: 1, container: 1, adr: 1 });
});
