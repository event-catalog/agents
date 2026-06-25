import type { ImpactPlanResponse } from '@/src/review-output';

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

export const getUnauthorizedCatalogChanges = (
  changedFiles: string[],
  plan: ImpactPlanResponse,
  catalogPath: string
): string[] => {
  const allowedTargets = plan.proposedCatalogTargets.map((target) => target.path).filter(Boolean);

  return changedFiles.filter(
    (file) => !allowedTargets.some((target) => isCatalogChangeAllowedByTarget(file, target, catalogPath))
  );
};
