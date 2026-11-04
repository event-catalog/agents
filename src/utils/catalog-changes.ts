import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type CatalogFileStatus = 'added' | 'modified' | 'deleted';

/** One changed file in the catalog, relative to the catalog root. */
export interface CatalogFileChange {
  path: string;
  status: CatalogFileStatus;
}

/** The changes to one catalog resource (an event, a service, a domain...), for PR comments and bodies. */
export interface ResourceChange {
  action: 'added' | 'updated' | 'removed';
  /** Singular resource type, e.g. `event`, or `file` for changes outside any resource folder. */
  type: string;
  /** The resource's folder name, e.g. `CustomerClosed`. */
  name: string;
  /** The resource folder, relative to the catalog root. */
  path: string;
  /** Changed files, relative to the resource folder. */
  files: string[];
  /** Versions archived under `versioned/` by this change. */
  archivedVersions: string[];
}

/** Catalog collection folder → singular resource type. */
const COLLECTIONS: Record<string, string> = {
  adrs: 'ADR',
  agents: 'agent',
  channels: 'channel',
  commands: 'command',
  containers: 'data store',
  'data-products': 'data product',
  diagrams: 'diagram',
  domains: 'domain',
  entities: 'entity',
  events: 'event',
  flows: 'flow',
  queries: 'query',
  services: 'service',
  systems: 'system',
  teams: 'team',
  users: 'user',
};

const run = async (cwd: string, args: string[]): Promise<string> =>
  (await execFileAsync('git', args, { cwd, maxBuffer: 1024 * 1024 * 20 })).stdout;

/**
 * Lists every changed file in the catalog checkout (`-uall`, so a new folder is listed file by file),
 * relative to the catalog root even when the catalog is a subfolder of its git repository.
 */
export const getCatalogFileChanges = async (catalogPath: string): Promise<CatalogFileChange[]> => {
  const prefix = (await run(catalogPath, ['rev-parse', '--show-prefix'])).trim();
  const status = await run(catalogPath, ['status', '--porcelain', '-uall', '.']);

  return status
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      const code = line.slice(0, 2);
      // Renames are listed as `old -> new`; the new path is the one that exists now.
      const repoPath = line.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, '');
      if (!repoPath.startsWith(prefix)) return [];
      const status: CatalogFileStatus = code.includes('D')
        ? 'deleted'
        : code.includes('?') || code.includes('A')
          ? 'added'
          : 'modified';
      return [{ path: repoPath.slice(prefix.length), status }];
    });
};

/** The deepest `<collection>/<name>` folder a path sits in, or undefined outside any resource. */
const findResourceFolder = (path: string): { type: string; name: string; path: string; rest: string[] } | undefined => {
  const segments = path.split('/');
  // Ignore `versioned/<version>/...`: an archived copy belongs to the resource that holds it.
  const versionedAt = segments.indexOf('versioned');
  const searchable = versionedAt === -1 ? segments : segments.slice(0, versionedAt);

  for (let i = searchable.length - 2; i >= 0; i--) {
    const type = COLLECTIONS[searchable[i]];
    if (!type) continue;
    // Most resources are folders (`<collection>/<name>/index.mdx`); teams and users are single files.
    if (i + 1 < segments.length - 1) {
      return { type, name: segments[i + 1], path: segments.slice(0, i + 2).join('/'), rest: segments.slice(i + 2) };
    }
    if (type === 'team' || type === 'user') {
      return { type, name: segments[i + 1].replace(/\.mdx?$/, ''), path, rest: [segments[i + 1]] };
    }
  }
  return undefined;
};

/** The file that defines the resource itself: its `index.mdx`, or the single file of a team or user. */
const isResourceDoc = (file: string, type: string): boolean =>
  /^index\.mdx?$/.test(file) || ((type === 'team' || type === 'user') && !file.includes('/'));

/** Groups changed catalog files by the resource they belong to, with what happened to each resource. */
export const describeCatalogChanges = (changes: CatalogFileChange[]): ResourceChange[] => {
  type Entry = ResourceChange & { statuses: Map<string, CatalogFileStatus> };
  const byResource = new Map<string, Entry>();

  for (const change of changes) {
    const folder = findResourceFolder(change.path);
    const key = folder?.path ?? change.path;
    const entry: Entry = byResource.get(key) ?? {
      action: 'updated',
      type: folder?.type ?? 'file',
      name: folder?.name ?? change.path,
      path: key,
      files: [],
      archivedVersions: [],
      statuses: new Map(),
    };

    const file = folder ? folder.rest.join('/') : change.path;
    const versioned = file.match(/^versioned\/([^/]+)\//);
    if (versioned) {
      if (!entry.archivedVersions.includes(versioned[1])) entry.archivedVersions.push(versioned[1]);
    } else {
      entry.files.push(file);
      entry.statuses.set(file, change.status);
    }
    byResource.set(key, entry);
  }

  return [...byResource.values()].map(({ statuses, ...entry }) => {
    const doc = [...statuses].find(([file]) => isResourceDoc(file, entry.type));
    const allDeleted = statuses.size > 0 && [...statuses.values()].every((status) => status === 'deleted');
    const action: ResourceChange['action'] =
      doc?.[1] === 'added' ? 'added' : allDeleted || doc?.[1] === 'deleted' ? 'removed' : 'updated';
    return { ...entry, action, files: entry.files.sort(), archivedVersions: entry.archivedVersions.sort() };
  });
};
