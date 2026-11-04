import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** A fixture's catalog copied into a fresh git repository, as the action checks it out. */
export type TempCatalog = {
  root: string;
  read: (path: string) => Promise<string>;
  write: (path: string, content: string) => Promise<void>;
  /** Rewrites a file with `replace(content)`. */
  edit: (path: string, replace: (content: string) => string) => Promise<void>;
  remove: () => Promise<void>;
};

/**
 * `inSubfolder` puts the catalog in `catalog/` inside the repository (as in the eval harness) instead
 * of at its root (as in the action), to cover both layouts.
 */
export const createTempCatalog = async (fixture: string, { inSubfolder = false } = {}): Promise<TempCatalog> => {
  const repo = await mkdtemp(join(tmpdir(), 'ec-catalog-'));
  const root = inSubfolder ? join(repo, 'catalog') : repo;
  await cp(join(import.meta.dirname, '..', 'fixtures', fixture, 'catalog'), root, { recursive: true });
  const git = (args: string[]) => exec('git', args, { cwd: repo });
  await git(['init', '-q']);
  await git(['add', '-A']);
  await git(['-c', 'user.email=eval@eventcatalog.dev', '-c', 'user.name=eval', 'commit', '-qm', 'fixture']);

  const read = (path: string) => readFile(join(root, path), 'utf8');
  const write = (path: string, content: string) => writeFile(join(root, path), content);

  return {
    root,
    read,
    write,
    edit: async (path, replace) => write(path, replace(await read(path))),
    remove: () => rm(repo, { recursive: true, force: true }),
  };
};
