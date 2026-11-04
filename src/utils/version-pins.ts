import { existsSync } from 'node:fs';
import { join } from 'node:path';
import utils from '@eventcatalog/sdk';
import type { ImpactPlanResponse } from '@/src/review-output';
import { isCatalogChangeAllowedByTarget } from '@/src/utils/impact-plan';

type Pointer = { id?: string; version?: string | number };

type DumpedResource = {
  id?: string;
  version?: string | number;
  sends?: Pointer[];
  receives?: Pointer[];
  _eventcatalog?: { directory?: string };
};

type ProposedTarget = ImpactPlanResponse['proposedCatalogTargets'][number];

const isExactVersion = (version: string): boolean => /^\d+\.\d+\.\d+$/.test(version);

/** `/domains/Orders/...` → `domains/Orders/...`; undefined for archived copies under `versioned/`. */
const resourceDirectory = (resource: DumpedResource): string | undefined => {
  const directory = resource._eventcatalog?.directory?.replace(/^\/+/, '');
  return directory && !directory.split('/').includes('versioned') ? directory : undefined;
};

const resourceDocPath = (catalogRoot: string, directory: string): string =>
  existsSync(join(catalogRoot, directory, 'index.md')) && !existsSync(join(catalogRoot, directory, 'index.mdx'))
    ? `${directory}/index.md`
    : `${directory}/index.mdx`;

/**
 * Adds the resources that pin a planned message's current version to the plan.
 *
 * When the agent bumps a message's version (e.g. for a breaking schema change), every service, agent
 * or domain that pins the old exact version has to change too, or the catalog contradicts itself. The
 * planning step tends to miss those files, and editing them anyway gets the whole run blocked as
 * off-plan, so they are added here from the catalog itself. Pins to `latest`, to a range, or with no
 * version follow the new version on their own and are left alone.
 *
 * `catalogRoot` is the absolute catalog path; `catalogPath` is the path the plan's targets may be
 * prefixed with (see `isCatalogChangeAllowedByTarget`).
 */
export const addVersionPinTargets = async (
  plan: ImpactPlanResponse,
  catalogRoot: string,
  catalogPath: string
): Promise<{ plan: ImpactPlanResponse; added: ProposedTarget[] }> => {
  const { dumpCatalog } = utils(catalogRoot);
  const { resources } = (await dumpCatalog({ includeMarkdown: false })) as {
    resources?: {
      domains?: DumpedResource[];
      services?: DumpedResource[];
      agents?: DumpedResource[];
      messages?: { events?: DumpedResource[]; commands?: DumpedResource[]; queries?: DumpedResource[] };
    };
  };

  const messages = [
    ...(resources?.messages?.events ?? []).map((resource) => ({ type: 'event', resource })),
    ...(resources?.messages?.commands ?? []).map((resource) => ({ type: 'command', resource })),
    ...(resources?.messages?.queries ?? []).map((resource) => ({ type: 'query', resource })),
  ].flatMap(({ type, resource }) => {
    const directory = resourceDirectory(resource);
    const version = String(resource.version ?? '');
    return directory && resource.id && isExactVersion(version) ? [{ type, id: resource.id, version, directory }] : [];
  });

  // A message is planned when a target is its folder, a file in it (its schema), or a folder above it.
  const plannedMessages = messages.filter((message) =>
    plan.proposedCatalogTargets.some((target) => isCatalogChangeAllowedByTarget(message.directory, target.path, catalogPath))
  );

  const pinHolders = [...(resources?.services ?? []), ...(resources?.agents ?? []), ...(resources?.domains ?? [])];
  const added: ProposedTarget[] = [];

  for (const holder of pinHolders) {
    const directory = resourceDirectory(holder);
    if (!directory) continue;

    const pins = plannedMessages.filter((message) =>
      [...(holder.sends ?? []), ...(holder.receives ?? [])].some(
        (pointer) => pointer.id === message.id && String(pointer.version ?? '') === message.version
      )
    );
    if (pins.length === 0) continue;

    const path = resourceDocPath(catalogRoot, directory);
    const alreadyAllowed = [...plan.proposedCatalogTargets, ...added].some((target) =>
      isCatalogChangeAllowedByTarget(path, target.path, catalogPath)
    );
    if (alreadyAllowed) continue;

    const pinned = pins.map((message) => `${message.type} ${message.id} ${message.version}`).join(', ');
    added.push({
      action: 'update',
      path,
      reason: `Pins ${pinned}. Only update this pin if you bump that version: always for a producer (sends), and for a consumer (receives) only when this pull request moves it to the new version.`,
    });
  }

  return { plan: { ...plan, proposedCatalogTargets: [...plan.proposedCatalogTargets, ...added] }, added };
};

/** `addVersionPinTargets` for the workflow: logs what it added, and on any failure keeps the plan as it was. */
export const withVersionPinTargets = async (
  plan: ImpactPlanResponse,
  catalogRoot: string,
  catalogPath: string
): Promise<ImpactPlanResponse> => {
  try {
    const { plan: expanded, added } = await addVersionPinTargets(plan, catalogRoot, catalogPath);
    if (added.length > 0) {
      console.error(
        `[eventcatalog:versions] Added ${added.length} version-pin target(s): ${added.map((t) => t.path).join(', ')}`
      );
    }
    return expanded;
  } catch (error) {
    console.error(`[eventcatalog:versions] Could not add version-pin targets: ${error instanceof Error ? error.message : error}`);
    return plan;
  }
};
