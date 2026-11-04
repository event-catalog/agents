import { defineTool } from '@flue/runtime';
import utils from '@eventcatalog/sdk';

type ResourcePointer = { id?: string };

type CatalogResource = {
  _eventcatalog?: {
    directory?: string;
  };
  id?: string;
  name?: string;
  owners?: unknown;
  summary?: string;
  version?: string;
  /** Systems only: the services and data stores the system contains. */
  services?: ResourcePointer[];
  containers?: ResourcePointer[];
};

type CatalogDump = {
  catalogVersion?: string;
  createdAt?: string;
  resources?: {
    adrs?: CatalogResource[];
    agents?: CatalogResource[];
    channels?: CatalogResource[];
    containers?: CatalogResource[];
    domains?: CatalogResource[];
    entities?: CatalogResource[];
    flows?: CatalogResource[];
    messages?: {
      commands?: CatalogResource[];
      events?: CatalogResource[];
      queries?: CatalogResource[];
    };
    services?: CatalogResource[];
    systems?: CatalogResource[];
  };
  version?: string;
};

type CatalogIndexResource = {
  id: string;
  name?: string;
  owners: string[];
  path?: string;
  summary?: string;
  type: string;
  version?: string;
  /** Systems only: ids of the services and data stores the system lists in its frontmatter. */
  services?: string[];
  containers?: string[];
};

const isVersionedPath = (path: string | undefined): boolean => path?.split('/').includes('versioned') ?? false;

const normalizeOwners = (owners: unknown): string[] =>
  Array.isArray(owners)
    ? owners.flatMap((owner) => {
        if (typeof owner === 'string') {
          return [owner];
        }

        if (owner && typeof owner === 'object' && 'id' in owner && typeof owner.id === 'string') {
          return [owner.id];
        }

        return [];
      })
    : [];

const compactResource = (type: string, resource: CatalogResource): CatalogIndexResource | undefined => {
  if (!resource.id || isVersionedPath(resource._eventcatalog?.directory)) {
    return undefined;
  }

  const path = resource._eventcatalog?.directory;
  const ids = (pointers: ResourcePointer[] | undefined) =>
    (pointers ?? []).flatMap((pointer) => (pointer.id ? [pointer.id] : []));

  return {
    id: resource.id,
    name: resource.name,
    owners: normalizeOwners(resource.owners),
    path,
    summary: resource.summary,
    type,
    version: resource.version,
    ...(type === 'system' ? { services: ids(resource.services), containers: ids(resource.containers) } : {}),
  };
};

const compactResources = (type: string, resources: CatalogResource[] | undefined): CatalogIndexResource[] =>
  (resources ?? []).flatMap((resource) => {
    const compact = compactResource(type, resource);
    return compact ? [compact] : [];
  });

export const createCatalogIndex = (catalog: CatalogDump) => {
  const resources = [
    ...compactResources('domain', catalog.resources?.domains),
    ...compactResources('system', catalog.resources?.systems),
    ...compactResources('service', catalog.resources?.services),
    ...compactResources('agent', catalog.resources?.agents),
    ...compactResources('event', catalog.resources?.messages?.events),
    ...compactResources('command', catalog.resources?.messages?.commands),
    ...compactResources('query', catalog.resources?.messages?.queries),
    ...compactResources('channel', catalog.resources?.channels),
    ...compactResources('entity', catalog.resources?.entities),
    ...compactResources('container', catalog.resources?.containers),
    ...compactResources('flow', catalog.resources?.flows),
    ...compactResources('adr', catalog.resources?.adrs),
  ];

  return {
    catalogVersion: catalog.catalogVersion,
    counts: resources.reduce<Record<string, number>>((counts, resource) => {
      counts[resource.type] = (counts[resource.type] ?? 0) + 1;
      return counts;
    }, {}),
    createdAt: catalog.createdAt,
    resources,
    version: catalog.version,
  };
};

/**
 * Gives the agent a structured EventCatalog dump so it can discover real
 * catalog resources instead of guessing file paths.
 */
export const createDumpCatalogTool = (catalogPath: string) =>
  defineTool({
    name: 'dump_catalog',
    description:
      'Dump a compact index of EventCatalog resources (domains, systems, services, agents, messages, channels, entities, data stores, flows, ADRs) with IDs, names, versions, summaries, and paths. Systems also list the services and data stores they contain.',
    run: async () => {
      if (!catalogPath) {
        throw new Error('Catalog path is not defined. Please provide a valid catalog path.');
      }

      const { dumpCatalog } = utils(catalogPath);
      const catalog = await dumpCatalog({ includeMarkdown: false });
      const index = createCatalogIndex(catalog);

      return { output: index };
    },
  });
