import { execFile } from 'node:child_process';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ReviewConfig } from '@/src/config';
import { getCatalogDisplayName, getCatalogProvider } from '@/src/providers';
import { resolveCatalogPath } from '@/src/utils/eventcatalog-utils';

/**
 * Checks out the catalog repository into the catalog path, for CI systems with no checkout step that can
 * do it (the GitHub Action uses actions/checkout instead; the Azure Pipelines template and the Bitbucket
 * Pipelines script run `src/checkout-catalog.ts`). It fetches only the tip of `catalog-ref`, like
 * actions/checkout, and works with a catalog on any provider. The token is sent through the environment for each command and never stored in the
 * checkout's git config, so the agent working in the catalog can't read it from there.
 */

const execFileAsync = promisify(execFile);

const SAFE_REF = /^[\w./-]+$/;

const isNonEmptyDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory() && (await readdir(path)).length > 0;
  } catch {
    return false;
  }
};

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

export const checkoutCatalog = async (config: ReviewConfig): Promise<string> => {
  const ref = config.catalogRef;
  if (!SAFE_REF.test(ref) || ref.startsWith('-') || ref.includes('..')) {
    throw new Error(`Invalid catalog ref: ${JSON.stringify(ref)}`);
  }

  const catalog = getCatalogProvider(config);
  const path = resolveCatalogPath(config);
  const name = getCatalogDisplayName(config);

  // A self-hosted agent can keep the workspace between runs: replace an earlier catalog checkout, but
  // never a directory that isn't one.
  if (await isNonEmptyDirectory(path)) {
    if (!(await isDirectory(join(path, '.git')))) {
      throw new Error(`Cannot check out the catalog into ${path}: the directory exists and is not a catalog checkout.`);
    }
    await rm(path, { recursive: true, force: true });
  }

  const git = (args: string[], env: Record<string, string> = {}) =>
    execFileAsync('git', args, { env: { ...process.env, ...env }, maxBuffer: 1024 * 1024 * 20 });

  await git(['init', '--quiet', path]);
  await git(['-C', path, 'remote', 'add', 'origin', catalog.cloneUrl()]);

  try {
    await git(
      ['-C', path, 'fetch', '--quiet', '--depth', '1', 'origin', `+refs/heads/${ref}:refs/remotes/origin/${ref}`],
      catalog.gitEnv()
    );
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr?.trim() || (error as Error).message;
    throw new Error(`Could not fetch branch "${ref}" from ${name}. Check the catalog repository, ref and token. ${detail}`);
  }

  await git(['-C', path, 'checkout', '--quiet', '-B', ref, `refs/remotes/origin/${ref}`]);
  console.error(`[eventcatalog:checkout] Checked out ${name}@${ref} into ${path}`);
  return path;
};
