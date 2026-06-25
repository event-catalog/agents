import * as v from 'valibot';

/**
 * Controlled vocabulary for `sourceChanges[].type`. A fixed enum (rather than free text) keeps the
 * impact plan machine-readable and gives the model one canonical term per kind of change — e.g.
 * "an existing event's payload changed" is always `schema-changed`, never `event-changed`.
 */
export const SOURCE_CHANGE_TYPES = [
  'event-added',
  'event-removed',
  'command-added',
  'command-removed',
  'query-added',
  'query-removed',
  'service-added',
  'service-removed',
  'service-changed',
  'schema-changed',
  'domain-changed',
  'docs-only',
] as const;

export type SourceChangeType = (typeof SOURCE_CHANGE_TYPES)[number];

export const impactPlanResponse = v.object({
  catalogChangesRequired: v.pipe(
    v.boolean(),
    v.description('Whether this source pull request requires EventCatalog documentation changes.')
  ),
  sourcePrSummary: v.pipe(
    v.string(),
    v.description('Concise high-level summary of the source pull request intent, based on the diff.')
  ),
  sourceChanges: v.pipe(
    v.array(
      v.object({
        confidence: v.pipe(v.string(), v.description('Confidence level for this source change: high, medium, or low.')),
        description: v.pipe(v.string(), v.description('What changed in the source pull request.')),
        evidence: v.pipe(v.array(v.string()), v.description('Source files or diff hunks that prove this change.')),
        id: v.pipe(v.string(), v.description('Stable identifier for the changed concept, such as OrderRefunded.')),
        type: v.pipe(
          v.picklist(SOURCE_CHANGE_TYPES),
          v.description(
            `Kind of source change. Pick the closest value: ${SOURCE_CHANGE_TYPES.join(', ')}. ` +
              "Use schema-changed when an existing message's payload/schema changes (e.g. a field is added). " +
              'Use *-added for a brand-new resource and *-removed when one is deleted.'
          )
        ),
      })
    ),
    v.description('Source changes that are relevant to EventCatalog documentation.')
  ),
  proposedCatalogTargets: v.pipe(
    v.array(
      v.object({
        action: v.pipe(v.string(), v.description('Expected catalog action: create, update, or delete.')),
        path: v.pipe(v.string(), v.description('Path relative to the EventCatalog root that may be changed.')),
        reason: v.pipe(v.string(), v.description('Why this catalog target is justified by the source PR diff.')),
      })
    ),
    v.description('Catalog files or resource folders that should be changed if catalogChangesRequired is true.')
  ),
  outOfScopeFindings: v.pipe(
    v.array(v.string()),
    v.description(
      'Catalog consistency issues noticed during review that are not directly introduced by this source pull request and must not be edited.'
    )
  ),
});

export const promptResponse = v.object({
  prTitle: v.pipe(
    v.string(),
    v.description('Descriptive title for the EventCatalog pull request to create or update in the catalog repository')
  ),
  prSummary: v.pipe(
    v.string(),
    v.description(
      'Markdown summary for the EventCatalog pull request body. Explain what catalog documentation changed and why it changed.'
    )
  ),
  sourcePrSummary: v.pipe(
    v.string(),
    v.description(
      'High-level markdown summary of what was done for the source pull request. Keep it concise; the source PR comment will include the catalog PR link separately.'
    )
  ),
});

export type ImpactPlanResponse = v.InferOutput<typeof impactPlanResponse>;
export type PromptResponse = v.InferOutput<typeof promptResponse>;

export const isPromptResponse = (result: unknown): result is PromptResponse => {
  if (!result || typeof result !== 'object') {
    return false;
  }

  const value = result as Partial<Record<keyof PromptResponse, unknown>>;

  return typeof value.prTitle === 'string' && typeof value.prSummary === 'string' && typeof value.sourcePrSummary === 'string';
};
