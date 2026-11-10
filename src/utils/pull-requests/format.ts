import type { ImpactPlanResponse } from '@/src/review-output';
import type { ResourceChange } from '@/src/utils/catalog-changes';

/** Markdown helpers shared by the source PR comments and the catalog PR body. */

export const truncate = (value: string, maxLength: number): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n\n...truncated`;

export const maxBacktickRun = (value: string): number =>
  Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));

export const formatInlineCode = (value: string): string => {
  const content = value.replace(/\s+/g, ' ').trim();
  const fence = '`'.repeat(Math.max(1, maxBacktickRun(content) + 1));
  const padding = content.includes('`') ? ' ' : '';

  return `${fence}${padding}${content || '(empty)'}${padding}${fence}`;
};

export const formatInlineText = (value: string): string => value.replace(/\s+/g, ' ').trim();

/** Text for a markdown table cell: one line, with pipes escaped. */
const formatCell = (value: string): string => formatInlineText(value).replace(/\|/g, '\\|');

/**
 * `https://github.com/acme/catalog/pull/21` → `acme/catalog#21`, and an Azure DevOps pull request
 * (`…/Architecture/_git/catalog/pullrequest/21`) → `Architecture/catalog!21`, the way Azure DevOps refers
 * to pull requests. Anything else is returned as is.
 */
export const formatPullRequestReference = (url: string): string => {
  const github = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (github) return `${github[1]}#${github[2]}`;

  const azure = url.match(/\/([^/]+)\/_git\/([^/?#]+)\/pullrequest\/(\d+)/);
  if (!azure) return url;
  try {
    return `${decodeURIComponent(azure[1])}/${decodeURIComponent(azure[2])}!${azure[3]}`;
  } catch {
    return url;
  }
};

const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

const ACTION_LABELS: Record<ResourceChange['action'], string> = { added: 'Added', updated: 'Updated', removed: 'Removed' };

/** A table of the catalog resources a review changed: what happened, to which resource, in which files. */
export const formatResourceChanges = (changes: ResourceChange[]): string => {
  const order: ResourceChange['action'][] = ['added', 'updated', 'removed'];
  const rows = [...changes]
    .sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action) || a.path.localeCompare(b.path))
    .map((change) => {
      const resource =
        change.type === 'file' ? formatInlineCode(change.path) : `${capitalize(change.type)} ${formatInlineCode(change.name)}`;
      const files = change.files.map(formatInlineCode);
      const archived = change.archivedVersions.map((version) => `previous version ${formatInlineCode(version)} archived`);
      return `| ${ACTION_LABELS[change.action]} | ${formatCell(resource)} | ${formatCell([...files, ...archived].join(', ') || '—')} |`;
    });

  return ['| Change | Resource | Files |', '| --- | --- | --- |', ...rows].join('\n');
};

/**
 * What a reviewer should look at: changes the agent was not fully sure about, and catalog issues it
 * noticed but left alone. Empty when there is nothing to flag.
 */
export const listReviewNotes = (plan: ImpactPlanResponse | undefined): string[] => {
  if (!plan) return [];
  const unsure = plan.sourceChanges
    .filter((change) => /^(low|medium)$/i.test(change.confidence.trim()))
    .slice(0, 5)
    .map(
      (change) => `Not fully sure (${change.confidence.trim().toLowerCase()} confidence): ${formatInlineText(change.description)}`
    );
  const noticed = plan.outOfScopeFindings
    .slice(0, 5)
    .map((finding) => `Noticed in the catalog but not changed: ${formatInlineText(finding)}`);
  return [...unsure, ...noticed];
};

/** Shifts headings so the shallowest one is `minLevel` (`##` → `###`), to nest model markdown under ours. */
export const nestHeadings = (markdown: string, minLevel: number): string => {
  // Lines inside fenced code blocks are code (`# comment`), not headings.
  let inFence = false;
  const lines = markdown.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    return { line, heading: inFence ? undefined : line.match(/^(#{1,6})(\s.*)$/) };
  });

  const levels = lines.flatMap(({ heading }) => (heading ? [heading[1].length] : []));
  const shift = levels.length > 0 ? minLevel - Math.min(...levels) : 0;
  if (shift <= 0) return markdown;

  return lines
    .map(({ line, heading }) => (heading ? `${'#'.repeat(Math.min(6, heading[1].length + shift))}${heading[2]}` : line))
    .join('\n');
};
