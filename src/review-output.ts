import * as v from 'valibot';
import { defineStructuredResult } from '@/src/agents/structured-results';

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
  catalogImpactSummary: v.pipe(
    v.string(),
    v.description(
      'One or two sentences for the pull request author on what this change means for the EventCatalog: what needs documenting, or why nothing does. Shown on the pull request, so do not restate the code change itself.'
    )
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
      'Markdown summary for the EventCatalog pull request body: what catalog documentation changed and why, in short paragraphs or bullets. Do not start with a heading or title, do not list the changed files, and do not link the source pull request; the pull request body adds those. Mention any linter or fitness_check problems you could not fix.'
    )
  ),
  sourcePrSummary: v.pipe(
    v.string(),
    v.description(
      'High-level markdown summary of what was done for the source pull request. Keep it concise; the source PR comment will include the catalog PR link separately.'
    )
  ),
});

/**
 * Structured result of scoring one changed schema for breaking changes. The breaking-changes
 * workflow runs this once per changed schema file so it can decide which schemas are worth tracing
 * to their downstream consumers.
 */
export const breakingChangeResponse = v.object({
  fileName: v.pipe(v.string(), v.description('Path of the schema file that was scored, relative to the repository root.')),
  isBreaking: v.pipe(
    v.boolean(),
    v.description(
      'Whether this schema change is likely to break existing consumers (removed/renamed fields, type changes, new required fields, narrowed enums, and similar).'
    )
  ),
  confidence: v.pipe(
    v.picklist(['high', 'medium', 'low']),
    v.description('Confidence that this change is breaking: high, medium, or low.')
  ),
  summary: v.pipe(
    v.string(),
    v.description('Concise explanation of why this change is or is not breaking, written for the pull request author.')
  ),
  breakingChanges: v.pipe(
    v.array(
      v.object({
        change: v.pipe(v.string(), v.description('The specific breaking change, e.g. "Removed required field `customerId`".')),
        lines: v.pipe(
          v.string(),
          v.description(
            'The exact line or lines from the diff that introduce this breaking change, copied verbatim so they can be highlighted.'
          )
        ),
      })
    ),
    v.description('The individual breaking changes found in this schema. Empty when isBreaking is false.')
  ),
});

/**
 * Structured result of tracing one breaking schema to its consumers in the EventCatalog. The agent
 * first resolves which catalog resource the schema belongs to, then finds anything that receives or
 * implements that message.
 */
export const schemaConsumersResponse = v.object({
  resource: v.pipe(
    v.string(),
    v.description(
      'The EventCatalog resource this schema belongs to, such as the message/service/domain id. Empty if it could not be resolved.'
    )
  ),
  diagram: v.pipe(
    v.string(),
    v.description(
      'A Mermaid flowchart showing producer/owning resource -> changed contract -> affected consumers. Empty when no diagram can be produced.'
    )
  ),
  consumers: v.pipe(
    v.array(
      v.object({
        id: v.pipe(v.string(), v.description('Id of the consuming catalog resource.')),
        version: v.pipe(v.string(), v.description('Version of the consuming catalog resource.')),
        type: v.pipe(v.string(), v.description('Type of the consuming resource: service, domain, message, flow, and similar.')),
        summary: v.pipe(
          v.string(),
          v.description('Summary of the consuming catalog resource. Empty if the catalog has no summary.')
        ),
        owners: v.pipe(
          v.array(v.string()),
          v.description('Owner team/user ids for the consuming resource. Empty if none are documented.')
        ),
        path: v.pipe(v.string(), v.description('Path to the consuming resource relative to the EventCatalog root.')),
        reason: v.pipe(
          v.string(),
          v.description(
            'Why this resource is affected, citing only what the catalog says, e.g. "Receives the OrderPlaced event (1.0.0)". Do not guess how the consumer uses particular fields unless the catalog documents it.'
          )
        ),
      })
    ),
    v.description(
      'Catalog resources that consume or implement this schema and may be affected by the breaking change. Empty when none are found.'
    )
  ),
});

/** ADR Compliance triage: which of the selected ADRs this pull request could plausibly conflict with. */
export const relevantAdrsResponse = v.object({
  relevantAdrIds: v.pipe(
    v.array(v.string()),
    v.description('Ids of the ADRs whose decision the changed code could plausibly affect. Empty when none could.')
  ),
});

/**
 * ADR Compliance review: where the changed code conflicts with an ADR. Each conflict cites a changed
 * line and quotes the ADR, and the workflow checks both before reporting it.
 */
export const adrComplianceResponse = v.object({
  conflicts: v.pipe(
    v.array(
      v.object({
        adrId: v.pipe(v.string(), v.description('Id of the ADR the change conflicts with.')),
        file: v.pipe(v.string(), v.description('Path of the changed file, exactly as given in the diff.')),
        line: v.pipe(v.number(), v.description('Line number labelled on the changed line that conflicts with the ADR.')),
        adrQuote: v.pipe(
          v.string(),
          v.description('The sentence from the ADR that the change conflicts with, copied word for word from a single sentence.')
        ),
        explanation: v.pipe(
          v.string(),
          v.description('One or two sentences for the pull request author on what the changed code does and why it conflicts.')
        ),
        suggestion: v.pipe(v.string(), v.description('One sentence on how to change the code so it follows the ADR.')),
      })
    ),
    v.description('Clear conflicts between the changed code and the ADRs. Empty when there are none, which is the usual result.')
  ),
});

/** Code-to-Docs plan step: the read-only impact plan. */
export const impactPlanResult = defineStructuredResult({
  name: 'impact_plan',
  schema: impactPlanResponse,
  description: 'Submit the EventCatalog documentation impact plan for this pull request. Ends the planning step.',
});

/** Code-to-Docs apply step: catalog PR title/summary after editing the approved targets. */
export const applyResult = defineStructuredResult({
  name: 'apply_result',
  schema: promptResponse,
  description: 'Submit the catalog pull request title and summaries after applying the approved plan. Ends the apply step.',
});

/** Breaking Changes detect step: the breaking-change score for one schema. */
export const breakingChangeResult = defineStructuredResult({
  name: 'breaking_change',
  schema: breakingChangeResponse,
  description: 'Submit the breaking-change assessment for the schema file under review. Ends the detect step.',
});

/** Breaking Changes trace step: the catalog consumers of a breaking schema. */
export const schemaConsumersResult = defineStructuredResult({
  name: 'schema_consumers',
  schema: schemaConsumersResponse,
  description: 'Submit the catalog consumers affected by the breaking schema change. Ends the trace step.',
});

/** ADR Compliance triage step: the ADRs worth reviewing in full. */
export const relevantAdrsResult = defineStructuredResult({
  name: 'relevant_adrs',
  schema: relevantAdrsResponse,
  description: 'Submit the ids of the ADRs this pull request could plausibly conflict with. Ends the triage step.',
});

/** ADR Compliance review step: the conflicts between the changed code and the ADRs. */
export const adrComplianceResult = defineStructuredResult({
  name: 'adr_compliance',
  schema: adrComplianceResponse,
  description: 'Submit the conflicts between the changed code and the ADRs. Ends the review step.',
});

export type ImpactPlanResponse = v.InferOutput<typeof impactPlanResponse>;
export type PromptResponse = v.InferOutput<typeof promptResponse>;
export type BreakingChangeResponse = v.InferOutput<typeof breakingChangeResponse>;
export type SchemaConsumersResponse = v.InferOutput<typeof schemaConsumersResponse>;
export type RelevantAdrsResponse = v.InferOutput<typeof relevantAdrsResponse>;
export type AdrConflict = v.InferOutput<typeof adrComplianceResponse>['conflicts'][number];
