import { execFile } from 'node:child_process';
import { access, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ReviewConfig } from '@/src/config';

const execFileAsync = promisify(execFile);

export type CatalogEntry = {
  name: string;
  type: 'directory' | 'file' | 'other';
};

export type CatalogInspection = {
  catalogPath: string;
  configPath: string;
  entries: CatalogEntry[];
  exists: boolean;
  hasConfig: boolean;
  ready: boolean;
};

export type MissingCatalogResult = {
  catalogPath: string;
  message: string;
  reviewed: 0;
  skipped: true;
};

const EVENTCATALOG_CONFIG_FILE = 'eventcatalog.config.js';
export const MISSING_CATALOG_MESSAGE = 'EventCatalog directory is missing, empty, or does not contain eventcatalog.config.js';

const getEntryType = (entry: { isDirectory(): boolean; isFile(): boolean }): CatalogEntry['type'] => {
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  return 'other';
};

export const resolveCatalogPath = (config: ReviewConfig): string => {
  const catalogPath = config.catalogPath || 'eventcatalog';
  return isAbsolute(catalogPath) ? catalogPath : resolve(config.workspace, catalogPath);
};

export const inspectCatalogDirectory = async (config: ReviewConfig): Promise<CatalogInspection> => {
  const catalogPath = resolveCatalogPath(config);
  const configPath = join(catalogPath, EVENTCATALOG_CONFIG_FILE);

  let entries: CatalogEntry[] = [];
  let exists = false;
  let hasConfig = false;

  try {
    const catalogStats = await stat(catalogPath);
    exists = catalogStats.isDirectory();
  } catch {
    exists = false;
  }

  if (exists) {
    entries = (await readdir(catalogPath, { withFileTypes: true }))
      .map((entry) => ({
        name: entry.name,
        type: getEntryType(entry),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    try {
      await access(configPath);
      hasConfig = true;
    } catch {
      hasConfig = false;
    }
  }

  return {
    catalogPath,
    configPath,
    entries,
    exists,
    hasConfig,
    ready: exists && entries.length > 0 && hasConfig,
  };
};

export const logCatalogInspection = (inspection: CatalogInspection): void => {
  console.error(`[eventcatalog:catalog] Catalog path: ${inspection.catalogPath}`);
  console.error(`[eventcatalog:catalog] Expected config: ${inspection.configPath}`);
  console.error(`[eventcatalog:catalog] Directory exists: ${inspection.exists ? 'yes' : 'no'}`);
  console.error(`[eventcatalog:catalog] Config exists: ${inspection.hasConfig ? 'yes' : 'no'}`);
  console.error(`[eventcatalog:catalog] Top-level entries found: ${inspection.entries.length}`);

  if (inspection.entries.length === 0) {
    return;
  }

  for (const entry of inspection.entries) {
    console.error(`[eventcatalog:catalog] - ${entry.type}: ${entry.name}`);
  }
};

export const doesCatalogExist = async (config: ReviewConfig): Promise<boolean> => {
  const inspection = await inspectCatalogDirectory(config);
  logCatalogInspection(inspection);

  return inspection.ready;
};

export const createMissingCatalogResult = (config: ReviewConfig): MissingCatalogResult => ({
  catalogPath: config.catalogPath,
  message: MISSING_CATALOG_MESSAGE,
  reviewed: 0,
  skipped: true,
});

export const getChangedCatalogFiles = async (catalogPath: string): Promise<string[]> => {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
    cwd: catalogPath,
    maxBuffer: 1024 * 1024 * 20,
  });

  return stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => line.slice(3));
};

export const discardCatalogChanges = async (catalogPath: string): Promise<void> => {
  await execFileAsync('git', ['restore', '--staged', '--worktree', '.'], {
    cwd: catalogPath,
    maxBuffer: 1024 * 1024 * 20,
  });
  await execFileAsync('git', ['clean', '-fd'], {
    cwd: catalogPath,
    maxBuffer: 1024 * 1024 * 20,
  });
};
