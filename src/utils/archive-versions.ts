import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { promisify } from 'node:util';
import { getCatalogFileChanges } from '@/src/utils/catalog-changes';

const execFileAsync = promisify(execFile);

const git = async (cwd: string, args: string[]): Promise<string> =>
  (await execFileAsync('git', args, { cwd, maxBuffer: 1024 * 1024 * 20 })).stdout;

/** Reads the top-level `version` from a resource's frontmatter. */
export const readFrontmatterVersion = (markdown: string): string | undefined => {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  return frontmatter?.match(/^version:\s*['"]?([^'"\s#]+)['"]?\s*$/m)?.[1];
};

export type ArchivedVersion = {
  /** The resource folder, relative to the catalog root. */
  path: string;
  version: string;
};

/**
 * Archives the previous version of every resource whose `version` changed in the working tree.
 *
 * EventCatalog keeps old versions in `<resource>/versioned/<version>/`. When the agent bumps a
 * version, this copies the resource's files as they were at `HEAD` (its `index.mdx`, schema, specs;
 * not nested resources) into that folder, so the old version stays documented and references to it
 * (a consumer still on the old version) keep resolving.
 *
 * The linter and fitness tools call it before they run, so the agent's checks see the archive; the
 * workflow calls it again before the off-plan check, which accepts these folders (see
 * `getUnauthorizedCatalogChanges`). The agent is never asked to write them. Safe to call repeatedly:
 * it returns every re-versioned resource, and only writes archives that don't exist yet.
 */
export const archivePreviousVersions = async (catalogRoot: string): Promise<ArchivedVersion[]> => {
  const prefix = (await git(catalogRoot, ['rev-parse', '--show-prefix'])).trim();
  const changes = await getCatalogFileChanges(catalogRoot);
  const archived: ArchivedVersion[] = [];

  for (const change of changes) {
    if (change.status !== 'modified' || !/(^|\/)index\.mdx?$/.test(change.path) || change.path.split('/').includes('versioned')) {
      continue;
    }

    const previous = readFrontmatterVersion(await git(catalogRoot, ['show', `HEAD:${prefix}${change.path}`]));
    const current = readFrontmatterVersion(await readFile(join(catalogRoot, change.path), 'utf8'));
    if (!previous || !current || previous === current) continue;

    const folder = posix.dirname(change.path);
    const archiveFolder = posix.join(folder, 'versioned', previous);
    archived.push({ path: folder, version: previous });
    if (existsSync(join(catalogRoot, archiveFolder))) continue;

    // Only the files directly in the resource folder: nested folders are other resources (a service's
    // events) or earlier archives.
    // `--full-tree`: paths from the repository root, like `HEAD:<path>`, even when the catalog is a subfolder.
    const entries = await git(catalogRoot, ['ls-tree', '--full-tree', 'HEAD', `${prefix}${folder}/`]);
    const files = entries
      .split('\n')
      .filter((line) => line.split(/\s+/)[1] === 'blob')
      .map((line) => line.split('\t')[1].slice(prefix.length));
    if (files.length === 0) continue;

    for (const file of files) {
      const target = join(catalogRoot, archiveFolder, posix.basename(file));
      const { stdout } = await execFileAsync('git', ['show', `HEAD:${prefix}${file}`], {
        cwd: catalogRoot,
        encoding: 'buffer',
        maxBuffer: 1024 * 1024 * 20,
      });
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, stdout);
    }

    console.error(`[eventcatalog:versions] Archived ${folder} ${previous} to ${archiveFolder}`);
  }

  return archived;
};
