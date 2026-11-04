import type { ImpactPlanResponse } from '@/src/review-output';
import type { ArchivedVersion } from '@/src/utils/archive-versions';

const normalizeCatalogPath = (value: string, catalogPath = 'eventcatalog'): string => {
  const normalized = value
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  const catalogRoot = catalogPath
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');

  return normalized.startsWith(`${catalogRoot}/`) ? normalized.slice(catalogRoot.length + 1) : normalized;
};

export const isCatalogChangeAllowedByTarget = (changedFile: string, targetPath: string, catalogPath: string): boolean => {
  const file = normalizeCatalogPath(changedFile, catalogPath);
  const target = normalizeCatalogPath(targetPath, catalogPath);

  return file === target || file.startsWith(`${target}/`) || target.startsWith(`${file}/`);
};

/**
 * Fitness functions are code that the `fitness_check` tool runs, so the agent may never write them,
 * whatever the plan says. Otherwise text in a source pull request could get code executed.
 */
export const isFitnessFunctionFile = (file: string): boolean =>
  file.replaceAll('\\', '/').split('/').includes('fitness') || /\.fitness\.[cm]?[jt]s$/.test(file);

/**
 * Catalog changes outside the approved plan. `archivedVersions` (from `archivePreviousVersions`) are
 * the workflow's own archive copies: a resource's `versioned/<version>/` folder is accepted when the
 * plan approved changing that resource's `index.mdx`. Fitness functions are never accepted.
 */
export const getUnauthorizedCatalogChanges = (
  changedFiles: string[],
  plan: ImpactPlanResponse,
  catalogPath: string,
  archivedVersions: ArchivedVersion[] = []
): string[] => {
  const allowedTargets = plan.proposedCatalogTargets.map((target) => target.path).filter(Boolean);
  const isAllowed = (file: string) => allowedTargets.some((target) => isCatalogChangeAllowedByTarget(file, target, catalogPath));

  const isArchiveCopy = (file: string) => {
    const path = normalizeCatalogPath(file, catalogPath);
    return archivedVersions.some(
      (archive) =>
        isAllowed(`${archive.path}/index.mdx`) &&
        // git lists a new folder as one entry: `<resource>/versioned/` or `<resource>/versioned/<version>/`.
        (path === `${archive.path}/versioned` ||
          path === `${archive.path}/versioned/${archive.version}` ||
          path.startsWith(`${archive.path}/versioned/${archive.version}/`))
    );
  };

  return changedFiles.filter((file) => isFitnessFunctionFile(file) || !(isAllowed(file) || isArchiveCopy(file)));
};
