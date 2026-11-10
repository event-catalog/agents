import { join } from 'node:path';
import { beforeAll, expect, test } from 'vitest';
import { resolveConfig } from '@/src/config';
import type { AdrConflict } from '@/src/review-output';
import {
  loadCatalogAdrs,
  matchesCatalogGlob,
  MISSING_ADRS_MESSAGE,
  noMatchingAdrsMessage,
  parseAdrExceptions,
  selectAdrs,
  verifyConflicts,
  type CatalogAdr,
} from '@/src/utils/adrs';
import { formatNumberedDiff, parseDiff } from '@/src/utils/diff';
import { formatAdrComplianceComment, formatAdrComplianceResolvedComment } from '@/src/utils/pull-requests/reporter';
import { review } from '@/src/workflows/adr-compliance';
import { scoreAdrCompliance } from './support/adr-compliance-scorers';
import { CATALOG_DOMAIN_ADRS } from './fixtures/adr-compliance/scenario';

/**
 * Offline guard for ADR Compliance: how ADRs are selected, how citations are checked, exceptions, and
 * the comment. Runs without a model or API key, so it always executes in CI.
 */

const CATALOG = join(import.meta.dirname, 'fixtures', 'adr-compliance', 'catalog');
const PATTERNS = CATALOG_DOMAIN_ADRS.split(', ');

let all: CatalogAdr[];
beforeAll(async () => {
  all = await loadCatalogAdrs(CATALOG);
});

const ids = (adrs: CatalogAdr[]) => adrs.map((adr) => adr.id.split('-').slice(0, 2).join('-')).sort();
const adr = (id: string) => all.find((candidate) => candidate.id.startsWith(id)) as CatalogAdr;

test('globs are anchored at the catalog root', () => {
  expect(matchesCatalogGlob('adrs/adr-1/index.mdx', 'adrs/**')).toBe(true);
  expect(matchesCatalogGlob('domains/Orders/adrs/adr-1/index.mdx', 'adrs/**')).toBe(false);
  expect(matchesCatalogGlob('domains/Orders/systems/s/adrs/adr-1/index.mdx', 'domains/Orders/**')).toBe(true);
  expect(matchesCatalogGlob('domains/OrdersV2/adrs/adr-1/index.mdx', 'domains/Orders/**')).toBe(false);
});

test('globs support every form the docs show', () => {
  expect(matchesCatalogGlob('adrs/adr-1/index.mdx', '**/adrs/**')).toBe(true);
  expect(matchesCatalogGlob('domains/Orders/adrs/adr-1/index.mdx', '**/adrs/**')).toBe(true);
  expect(matchesCatalogGlob('adrs/adr-orders-1/index.mdx', 'adrs/adr-orders-*/**')).toBe(true);
  expect(matchesCatalogGlob('adrs/adr-payments-1/index.mdx', 'adrs/adr-orders-*/**')).toBe(false);
  expect(matchesCatalogGlob('domains/Orders/adrs/adr-1/index.mdx', 'domains/Orders')).toBe(true);
  expect(matchesCatalogGlob('adrs/adr-1/index.mdx', './adrs/adr-1/')).toBe(true);
  expect(matchesCatalogGlob('adrs/adr-1x/index.mdx', 'adrs/adr-1')).toBe(false);
});

test('loads the latest version of ADRs wherever they live, not the versioned copies', () => {
  expect(ids(all)).toEqual(['adr-001', 'adr-003', 'adr-004', 'adr-010', 'adr-100', 'adr-101', 'adr-102', 'adr-200']);
  expect(adr('adr-003').version).toBe('2.0.0');
  expect(adr('adr-003').markdown).toContain('never in the Product API request path');
});

test('checks only accepted ADRs the globs select', () => {
  const { matched, active } = selectAdrs(all, PATTERNS);
  // Payments is out of scope; the proposed and superseded ADRs match the globs but are not checked.
  expect(ids(matched)).toEqual(['adr-001', 'adr-003', 'adr-004', 'adr-010', 'adr-100', 'adr-101', 'adr-102']);
  expect(ids(active)).toEqual(['adr-001', 'adr-003', 'adr-010', 'adr-100', 'adr-102']);
});

test('includes an accepted amendment even when the globs miss it', () => {
  const { active } = selectAdrs(all, ['adrs/adr-102-*/**']);
  expect(ids(active)).toEqual(['adr-010', 'adr-102']);
  // The relationship counts when it is declared on either side.
  const { active: fromAmends } = selectAdrs(
    all.map((candidate) => ({ ...candidate, amendedBy: [] })),
    ['adrs/adr-102-*/**']
  );
  expect(ids(fromAmends)).toEqual(['adr-010', 'adr-102']);
});

test('the input is read from the payload or the action environment', () => {
  expect(resolveConfig({ adrs: 'adrs/**, domains/Orders/**' }, {}).adrs).toEqual(['adrs/**', 'domains/Orders/**']);
  expect(resolveConfig({}, { EVENTCATALOG_ADRS: 'adrs/**' }).adrs).toEqual(['adrs/**']);
  expect(resolveConfig({}, {}).adrs).toEqual([]);
});

test('a missing or mistyped adrs input fails the run before any model work', async () => {
  const missing = resolveConfig({ catalogPath: CATALOG }, {});
  await expect(review(undefined, missing)).rejects.toThrow(MISSING_ADRS_MESSAGE);

  const typo = resolveConfig({ catalogPath: CATALOG, adrs: 'domains/Catalogue/**' }, {});
  await expect(review(undefined, typo)).rejects.toThrow('The `adrs` input matched no ADRs (`domains/Catalogue/**`)');
});

test('the no-match error shows where the ADRs actually are', () => {
  expect(noMatchingAdrsMessage(['nope/**'], all)).toContain('The catalog has 8 ADR(s), for example: `');
  expect(noMatchingAdrsMessage(['nope/**'], [])).toContain('The catalog has no ADRs.');
});

test('a pull request closed without merging is skipped, even with no adrs input', async () => {
  const closed = resolveConfig({ pullRequestState: 'closed' }, {});
  expect((await review(undefined, closed)).outcome).toBe('closed_without_merge');
});

const DIFF = `diff --git a/src/a.js b/src/a.js
index 1..2 100644
--- a/src/a.js
+++ b/src/a.js
@@ -5,0 +6,2 @@ function a() {
+const one = 1;
+const two = 2;
@@ -20 +22 @@ function b() {
-const old = 'old';
+const updated = 'new';
@@ -40,2 +41,0 @@ function c() {
-const gone = 1;
-const alsoGone = 2;`;

test('numbers each changed line, matching the ranges parseDiff records', () => {
  const numbered = formatNumberedDiff(DIFF);
  expect(numbered).toContain('6: +const one = 1;');
  expect(numbered).toContain('7: +const two = 2;');
  expect(numbered).toContain("22: -const old = 'old';");
  expect(numbered).toContain("22: +const updated = 'new';");
  expect(numbered).toContain('41: -const gone = 1;');
  // Headers are left alone, even though they start with + and -.
  expect(numbered).toContain('\n--- a/src/a.js\n+++ b/src/a.js\n');

  const [{ changedLines }] = parseDiff(DIFF, '/workspace');
  expect(changedLines).toEqual([
    { start: 6, end: 7 },
    { start: 22, end: 22 },
    { start: 41, end: 41, isPureDeletion: true },
  ]);
});

const changedFiles = [{ fileName: 'src/a.js', diff: DIFF, changedLines: parseDiff(DIFF, '/workspace')[0].changedLines }];

const conflict = (overrides: Partial<AdrConflict> = {}): AdrConflict => ({
  adrId: 'adr-003-offload-async-work-to-worker',
  file: 'src/a.js',
  line: 7,
  adrQuote:
    'Enrichment, media processing and bulk imports must run in the product-worker, never in the Product API request path.',
  explanation: 'Resizes images in the request handler.',
  suggestion: 'Send a job to the worker.',
  ...overrides,
});

test('keeps a conflict whose citation checks out, including a cited removed line', () => {
  const { verified, rejected } = verifyConflicts([conflict(), conflict({ line: 41 })], all, changedFiles);
  expect(rejected).toEqual([]);
  expect(verified).toHaveLength(2);
});

test('a quote still matches when the model drops markdown from the ADR', () => {
  // The ADR writes [[container|product-database]] and **and**.
  const quote =
    'The Product API writes every product change and a corresponding row in an outbox table inside a single database transaction in the product-database.';
  const { verified } = verifyConflicts(
    [conflict({ adrId: 'adr-001-use-transactional-outbox', adrQuote: quote })],
    all,
    changedFiles
  );
  expect(verified).toHaveLength(1);
});

test.each([
  ['an ADR that is not under review', { adrId: 'adr-999-made-up' }, 'not one of the ADRs under review'],
  ['a file the pull request did not change', { file: 'src/other.js' }, 'not a changed file'],
  ['a line the pull request did not change', { line: 10 }, 'not a changed line'],
  ['a quote the ADR does not contain', { adrQuote: 'All image processing must happen on a GPU.' }, 'the quote is not from'],
  ['a quote too short to prove anything', { adrQuote: 'the Product API' }, 'the quote is not from'],
])('drops a conflict citing %s', (_label, overrides, reason) => {
  const { verified, rejected } = verifyConflicts([conflict(overrides)], all, changedFiles);
  expect(verified).toEqual([]);
  expect(rejected[0].reason).toContain(reason);
});

test('reads exceptions from the pull request description, requiring a reason', () => {
  const exceptions = parseAdrExceptions(`Some description.

adr-exception: adr-003 image resize takes under 5ms
  ADR-Exception: \`adr-001\` backfill script only
adr-exception: adr-100
mentions adr-exception: adr-102 mid-sentence`);

  expect([...exceptions]).toEqual([
    ['adr-003', 'image resize takes under 5ms'],
    ['adr-001', 'backfill script only'],
  ]);
  expect(parseAdrExceptions(undefined).size).toBe(0);
});

const context = resolveConfig(
  {
    adrs: PATTERNS,
    catalogRepo: 'acme/catalog',
    githubRepository: 'acme/shop',
    githubToken: 'token',
    headSha: 'abc123',
    prNumber: 7,
  },
  {}
);

test('the comment cites the line, links the ADR, and offers a way forward', () => {
  const comment = formatAdrComplianceComment({ conflicts: [conflict()], exceptions: [], adrs: all }, context);

  expect(comment).toContain('### ⚠️ Possible conflict with 1 architecture decision');
  expect(comment).toContain(
    '[ADR-003: Offload long-running catalog work to a dedicated worker](https://github.com/acme/catalog/tree/main/domains/Catalog/systems/product-catalog-system/adrs/adr-003-offload-async-work-to-worker)'
  );
  expect(comment).toContain('[`src/a.js:7`](https://github.com/acme/shop/blob/abc123/src/a.js#L7)');
  expect(comment).toContain('> Enrichment, media processing');
  expect(comment).toContain('**Suggestion:** Send a job to the worker.');
  expect(comment).toContain('`adr-exception: <adr-id> <reason>`');
  expect(comment).toContain('checked against 8 accepted ADRs matching `adrs/**`, `domains/Catalog/**`');
});

test('the comment shows catalog resource links in a quote as plain names', () => {
  const comment = formatAdrComplianceComment(
    {
      conflicts: [conflict({ adrQuote: 'Media processing must run in the [[service|product-worker]], never in the API.' })],
      exceptions: [],
      adrs: all,
    },
    context
  );
  expect(comment).toContain('> Media processing must run in the product-worker, never in the API.');
  expect(
    verifyConflicts(
      [conflict({ adrQuote: 'must run in the [[service|product-worker]], never in the Product API' })],
      all,
      changedFiles
    ).verified
  ).toHaveLength(1);
});

test('the comment links to the hosted catalog when one is configured', () => {
  const comment = formatAdrComplianceComment(
    { conflicts: [conflict()], exceptions: [], adrs: all },
    { ...context, catalogUrl: 'https://catalog.example.com' }
  );
  expect(comment).toContain('(https://catalog.example.com/docs/adrs/adr-003-offload-async-work-to-worker/2.0.0)');
});

test('the comment groups conflicts by ADR', () => {
  const comment = formatAdrComplianceComment(
    { conflicts: [conflict(), conflict({ line: 22 })], exceptions: [], adrs: all },
    context
  );
  expect(comment).toContain('### ⚠️ Possible conflict with 1 architecture decision');
  expect(comment.match(/^#### /gm)).toHaveLength(1);
  expect(comment).toContain('src/a.js:22');
});

test('a recorded exception replaces the conflict in the comment, so reviewers still see it', () => {
  const comment = formatAdrComplianceComment(
    {
      conflicts: [],
      exceptions: [{ adrId: 'adr-003-offload-async-work-to-worker', reason: 'image resize takes under 5ms' }],
      adrs: all,
    },
    context
  );
  expect(comment).toContain('### 📝 1 architecture decision exception recorded');
  expect(comment).toContain('image resize takes under 5ms');
  expect(comment).not.toContain('**Suggestion:**');
});

test('the resolved comment replaces the earlier warning', () => {
  const comment = formatAdrComplianceResolvedComment(all, context);
  expect(comment).toContain('<!-- eventcatalog-actions:adr-compliance -->');
  expect(comment).toContain('### ✅ No architecture decision conflicts');
});

test('the scorer fails a missed conflict, a failed citation, and any extra ADR', () => {
  const pass = scoreAdrCompliance({ conflicts: [conflict()], rejected: [] }, { conflictingAdrIds: [conflict().adrId] });
  expect(pass).toEqual({ score: 1, failures: [] });

  const missed = scoreAdrCompliance({ conflicts: [], rejected: [] }, { conflictingAdrIds: [conflict().adrId] });
  expect(missed.score).toBe(0);

  const badCitation = scoreAdrCompliance(
    { conflicts: [], rejected: [{ conflict: conflict(), reason: 'x' }] },
    { conflictingAdrIds: [conflict().adrId] }
  );
  expect(badCitation.failures[0]).toContain('failed verification');

  const falseAlarm = scoreAdrCompliance({ conflicts: [conflict()], rejected: [] }, { conflictingAdrIds: [] });
  expect(falseAlarm.score).toBe(0);

  const extraAdr = scoreAdrCompliance(
    { conflicts: [conflict(), conflict({ adrId: 'adr-010-media-jobs-use-sqs' })], rejected: [] },
    { conflictingAdrIds: [conflict().adrId] }
  );
  expect(extraAdr.failures).toEqual(['Did not expect a conflict with "adr-010-media-jobs-use-sqs", but it was reported.']);
  expect(scoreAdrCompliance({ conflicts: [], rejected: [] }, { conflictingAdrIds: [] }).score).toBe(1);
});
