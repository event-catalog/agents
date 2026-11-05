import utils from '@eventcatalog/sdk';
import type { AdrConflict } from '@/src/review-output';
import type { ChangedFile } from '@/src/review-types';
import { normalizePath } from '@/src/utils/diff';

/** Deterministic ADR handling for the ADR Compliance agent: selection, citation checks, exceptions. */

type AdrPointer = { id: string; type?: string; version?: string };

/** An ADR's latest version, as read from the catalog. `path` is its folder, relative to the catalog root. */
export type CatalogAdr = {
  id: string;
  name: string;
  version: string;
  summary: string;
  status: string;
  path: string;
  appliesTo: AdrPointer[];
  amends: AdrPointer[];
  amendedBy: AdrPointer[];
  markdown: string;
};

type DumpedAdr = Partial<Omit<CatalogAdr, 'path'>> & { _eventcatalog?: { directory?: string } };

const REGEX_SPECIAL_CHARS = /[.+^${}()|[\]\\]/g;

/**
 * Whether a path matches a glob relative to the catalog root. Unlike `isIgnoredPath`, which matches
 * anywhere in a path, this is anchored: `adrs/**` is the top-level folder only, not any folder called
 * `adrs`. A pattern also matches everything below it, so `domains/Orders` means the whole domain.
 */
export const matchesCatalogGlob = (path: string, pattern: string): boolean => {
  const source = normalizePath(pattern)
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) => {
      if (part === '**/') return '(?:.*/)?';
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      if (part === '?') return '[^/]';
      return part.replace(REGEX_SPECIAL_CHARS, '\\$&');
    })
    .join('');

  return new RegExp(`^${source}(?:/.*)?$`).test(normalizePath(path));
};

/** The latest version of every ADR in the catalog, wherever it lives. */
export const loadCatalogAdrs = async (catalogPath: string): Promise<CatalogAdr[]> => {
  const { dumpCatalog } = utils(catalogPath);
  const catalog = await dumpCatalog({ includeMarkdown: true });
  const dumped = (catalog.resources?.adrs ?? []) as DumpedAdr[];

  return dumped.flatMap((adr) => {
    const path = normalizePath(adr._eventcatalog?.directory ?? '');
    if (!adr.id || !path || path.split('/').includes('versioned')) return [];

    return [
      {
        id: adr.id,
        name: adr.name ?? adr.id,
        version: adr.version ?? '',
        summary: adr.summary ?? '',
        status: adr.status ?? '',
        path,
        appliesTo: adr.appliesTo ?? [],
        amends: adr.amends ?? [],
        amendedBy: adr.amendedBy ?? [],
        markdown: adr.markdown ?? '',
      },
    ];
  });
};

const isAccepted = (adr: CatalogAdr): boolean => adr.status === 'accepted';
const refersTo = (pointers: AdrPointer[], adr: CatalogAdr): boolean => pointers.some((pointer) => pointer.id === adr.id);

/**
 * `matched` is every ADR the globs selected, so a typo can be told apart from a catalog with nothing
 * accepted. `active` is what gets checked: the accepted ones, plus any accepted ADR amending them,
 * because an amended decision can't be judged correctly without its amendment.
 */
export const selectAdrs = (all: CatalogAdr[], patterns: string[]): { matched: CatalogAdr[]; active: CatalogAdr[] } => {
  const matched = all.filter((adr) => patterns.some((pattern) => matchesCatalogGlob(`${adr.path}/index.mdx`, pattern)));
  const accepted = matched.filter(isAccepted);
  const amendments = all.filter(
    (adr) =>
      isAccepted(adr) &&
      !accepted.includes(adr) &&
      accepted.some((selected) => refersTo(selected.amendedBy, adr) || refersTo(adr.amends, selected))
  );

  return { matched, active: [...accepted, ...amendments] };
};

export const MISSING_ADRS_MESSAGE =
  'The ADR Compliance agent needs the `adrs` input to know which ADRs to check against. Set it to globs relative to the catalog root, for example `adrs: adrs/**, domains/Orders/**`.';

export const noMatchingAdrsMessage = (patterns: string[], all: CatalogAdr[]): string => {
  const examples = all.slice(0, 5).map((adr) => `\`${adr.path}\``);
  const found =
    all.length > 0 ? `The catalog has ${all.length} ADR(s), for example: ${examples.join(', ')}.` : 'The catalog has no ADRs.';
  return `The \`adrs\` input matched no ADRs (${patterns.map((pattern) => `\`${pattern}\``).join(', ')}). ${found}`;
};

/** Replaces EventCatalog resource links (`[[service|product-api]]`) with the resource's id. */
export const stripResourceLinks = (text: string): string =>
  text.replace(/\[\[[^\]|]*\|([^\]]+)\]\]/g, '$1').replace(/\[\[([^\]]+)\]\]/g, '$1');

/** Reduces markdown to its words, so a quote still matches when the model drops links or emphasis. */
const normalizeQuote = (text: string): string =>
  stripResourceLinks(text)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:]+$/, '')
    .toLowerCase();

/** Shorter than this, a quote is a phrase that proves nothing about what the ADR decided. */
const MIN_QUOTE_WORDS = 5;

const rejectionReason = (conflict: AdrConflict, adrs: CatalogAdr[], changedFiles: ChangedFile[]): string | undefined => {
  const adr = adrs.find((candidate) => candidate.id === conflict.adrId);
  if (!adr) return `"${conflict.adrId}" is not one of the ADRs under review`;

  const file = changedFiles.find((candidate) => normalizePath(candidate.fileName) === normalizePath(conflict.file));
  if (!file) return `${conflict.file} is not a changed file`;

  const inChangedLines = (file.changedLines ?? []).some((range) => conflict.line >= range.start && conflict.line <= range.end);
  if (!inChangedLines) return `${conflict.file}:${conflict.line} is not a changed line`;

  const quote = normalizeQuote(conflict.adrQuote);
  if (quote.split(' ').length < MIN_QUOTE_WORDS || !normalizeQuote(adr.markdown).includes(quote)) {
    return `the quote is not from ${adr.id}`;
  }

  return undefined;
};

/**
 * Keeps only conflicts we can prove: the cited ADR is under review, the cited line is one this pull
 * request changed, and the quote is really in the ADR. The model's output is untrusted, and a warning
 * citing a line or sentence that doesn't exist would cost the agent its credibility.
 */
export const verifyConflicts = (
  conflicts: AdrConflict[],
  adrs: CatalogAdr[],
  changedFiles: ChangedFile[]
): { verified: AdrConflict[]; rejected: { conflict: AdrConflict; reason: string }[] } => {
  const verified: AdrConflict[] = [];
  const rejected: { conflict: AdrConflict; reason: string }[] = [];

  for (const conflict of conflicts) {
    const reason = rejectionReason(conflict, adrs, changedFiles);
    if (reason) rejected.push({ conflict, reason });
    else verified.push(conflict);
  }

  return { verified, rejected };
};

/** `adr-exception: <adr-id> <reason>` lines in a pull request description. A reason is required. */
export const parseAdrExceptions = (body: string | undefined): Map<string, string> => {
  const exceptions = new Map<string, string>();

  for (const match of (body ?? '').matchAll(/^[ \t]*adr-exception:[ \t]*`?([^\s`]+)`?[ \t]+(\S.*?)[ \t\r]*$/gim)) {
    exceptions.set(match[1], match[2]);
  }

  return exceptions;
};
