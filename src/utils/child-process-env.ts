import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Environment variables a child process needs to run node and npx; nothing else is passed on. */
const ALLOWED_ENV = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'CI',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'npm_config_registry',
  'NPM_CONFIG_REGISTRY',
];

/**
 * The environment for tools that run catalog code or npm packages (the linter, fitness functions).
 * The run's own environment holds the model provider key and GitHub tokens, so it is never passed
 * through: those tools only get what they need to run.
 */
export const childProcessEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(ALLOWED_ENV.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])));

/**
 * The version of an `@eventcatalog/*` tool the catalog pins in its `package.json` (dependencies or
 * devDependencies), when it is a plain version or `^`/`~` range. Otherwise undefined.
 */
export const getCatalogPackageVersion = (catalogRoot: string, packageName: string): string | undefined => {
  try {
    const manifest = JSON.parse(readFileSync(join(catalogRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const spec = manifest.dependencies?.[packageName] ?? manifest.devDependencies?.[packageName];
    return spec && /^[~^]?\d+\.\d+\.\d+$/.test(spec.trim()) ? spec.trim() : undefined;
  } catch {
    return undefined;
  }
};
