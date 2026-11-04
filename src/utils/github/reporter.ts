import { Octokit } from 'octokit';
import type { ReviewConfig } from '@/src/config';
import type { BreakingChangeResponse, ImpactPlanResponse, SchemaConsumersResponse } from '@/src/review-output';
import type { ResourceChange } from '@/src/utils/catalog-changes';
import {
  formatInlineCode,
  formatInlineText,
  formatPullRequestReference,
  formatResourceChanges,
  listReviewNotes,
  maxBacktickRun,
} from '@/src/utils/github/format';

const COMMENT_MARKER = '<!-- eventcatalog-actions:pr-review -->';
const BREAKING_CHANGES_COMMENT_MARKER = '<!-- eventcatalog-actions:breaking-changes -->';
const ISSUES_URL = 'https://github.com/event-catalog/agents/issues';

/** What a Code-to-Docs run did, for the comment on the source pull request. */
export type ReviewComment =
  | {
      /** The catalog was updated: a catalog pull request was opened or updated. */
      kind: 'catalog-updated';
      catalogPullRequestUrl?: string;
      changes: ResourceChange[];
      impactPlan: ImpactPlanResponse;
      reviewedFiles: number;
    }
  | {
      /** The review found nothing to document. */
      kind: 'no-changes';
      impactPlan: ImpactPlanResponse;
      reviewedFiles: number;
      /** Extra context, e.g. when the agent planned changes but ended up making none. */
      note?: string;
    }
  | {
      /** The agent edited files outside its approved plan, so nothing was pushed. */
      kind: 'off-plan';
      impactPlan: ImpactPlanResponse;
      unauthorizedChanges: string[];
      reviewedFiles: number;
    }
  | {
      /** The review could not run, e.g. the catalog is missing or the token can't reach it. */
      kind: 'not-run';
      reason: string;
      nextStep: string;
    };

type CommentContext = Pick<ReviewConfig, 'catalogRepo' | 'catalogRef'>;

const formatFooter = (context: CommentContext, reviewedFiles?: number): string => {
  const catalog = context.catalogRepo
    ? `catalog [${context.catalogRepo}@${context.catalogRef}](https://github.com/${context.catalogRepo}/tree/${encodeURI(context.catalogRef)})`
    : undefined;
  const reviewed =
    reviewedFiles === undefined ? undefined : `reviewed ${reviewedFiles} changed file${reviewedFiles === 1 ? '' : 's'}`;
  return `<sub>${['EventCatalog Agents · Code-to-Docs', reviewed, catalog].filter(Boolean).join(' · ')}</sub>`;
};

const formatNotes = (plan: ImpactPlanResponse): string => {
  const notes = listReviewNotes(plan);
  return notes.length > 0 ? `\n\n**Worth checking**\n\n${notes.map((note) => `- ${note}`).join('\n')}` : '';
};

const impactSummary = (plan: ImpactPlanResponse): string =>
  formatInlineText(plan.catalogImpactSummary || plan.sourcePrSummary || 'No summary was returned.');

export const formatReviewComment = (comment: ReviewComment, context: CommentContext): string => {
  switch (comment.kind) {
    case 'catalog-updated': {
      const pullRequest = comment.catalogPullRequestUrl
        ? `Opened [${formatPullRequestReference(comment.catalogPullRequestUrl)}](${comment.catalogPullRequestUrl}) to keep the catalog in sync with this pull request.`
        : 'Updated the catalog to keep it in sync with this pull request.';

      return `${COMMENT_MARKER}
### 📘 EventCatalog docs updated

${pullRequest}

${formatResourceChanges(comment.changes)}${formatNotes(comment.impactPlan)}

${formatFooter(context, comment.reviewedFiles)}
`;
    }

    case 'no-changes':
      return `${COMMENT_MARKER}
### 📘 No EventCatalog changes needed

${impactSummary(comment.impactPlan)}${comment.note ? `\n\n${formatInlineText(comment.note)}` : ''}${formatNotes(comment.impactPlan)}

${formatFooter(context, comment.reviewedFiles)}
`;

    case 'off-plan': {
      const planned = comment.impactPlan.proposedCatalogTargets
        .map((target) => `- ${formatInlineCode(target.path)} (${formatInlineText(target.action)})`)
        .join('\n');
      const unplanned = comment.unauthorizedChanges.map((file) => `- ${formatInlineCode(file)}`).join('\n');

      return `${COMMENT_MARKER}
### ⚠️ EventCatalog docs not updated

The agent edited catalog files outside the plan it was approved to change, so nothing was pushed and no catalog pull request was opened.

**Planned changes**

${planned || '- (none)'}

**Edited outside the plan**

${unplanned}

**Next step:** re-run this workflow to try again, or make the planned changes by hand. If it keeps happening, please [open an issue](${ISSUES_URL}).

${formatFooter(context, comment.reviewedFiles)}
`;
    }

    case 'not-run':
      return `${COMMENT_MARKER}
### ⏭️ EventCatalog docs not checked

${formatInlineText(comment.reason)}

**Next step:** ${formatInlineText(comment.nextStep)}

${formatFooter(context)}
`;
  }
};

/**
 * Creates a new pull request comment, or updates the existing one that carries `marker`. Both the
 * PR review and breaking-changes workflows post a single, self-updating comment this way, so reruns
 * replace their previous comment instead of stacking up new ones.
 */
const upsertPullRequestComment = async (config: ReviewConfig, marker: string, body: string): Promise<string | undefined> => {
  if (!config.github) {
    console.error('[eventcatalog:github] No GitHub PR context found; skipping pull request comment.');
    return undefined;
  }

  const { owner, repo, prNumber, token } = config.github;
  const octokit = new Octokit({ auth: token });

  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });

  const existingComment = comments.find((comment) => comment.body?.includes(marker));

  if (existingComment) {
    const { data } = await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existingComment.id,
      body,
    });

    console.error(`[eventcatalog:github] Updated pull request comment: ${data.html_url}`);
    return data.html_url;
  }

  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });

  console.error(`[eventcatalog:github] Created pull request comment: ${data.html_url}`);
  return data.html_url;
};

export const postPullRequestSummary = async (config: ReviewConfig, comment: ReviewComment): Promise<string | undefined> =>
  upsertPullRequestComment(config, COMMENT_MARKER, formatReviewComment(comment, config));

const formatCodeBlock = (value: string, language = ''): string => {
  const content = value.replace(/\r\n?/g, '\n').trimEnd() || '(No diff lines returned.)';
  const fence = '`'.repeat(Math.max(3, maxBacktickRun(content) + 1));

  return `${fence}${language}\n${content}\n${fence}`;
};

const formatMermaidBlock = (value: string): string => {
  const content = value
    .replace(/\r\n?/g, '\n')
    .trim()
    .replace(/^```(?:mermaid)?\s*\n/i, '')
    .replace(/\n```$/i, '');
  const hasDiagramType =
    /^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|mindmap|timeline|zenuml|sankey-beta|xychart-beta|block-beta|packet-beta|architecture-beta)\b/i.test(
      content
    );
  const normalized = content && !hasDiagramType ? `flowchart LR\n${content}` : content;

  return formatCodeBlock(normalized, 'mermaid');
};

const formatMarkdownLink = (label: string, url: string): string => `[${label.replace(/[[\]\\]/g, '\\$&')}](${url})`;

const normalizeCatalogUrl = (catalogUrl: string | undefined): string | undefined => {
  const trimmed = catalogUrl?.trim().replace(/\/+$/, '');

  if (!trimmed) {
    return undefined;
  }

  return trimmed.replace(/\/docs$/i, '');
};

const encodeUrlSegment = (segment: string): string => encodeURIComponent(segment.trim());

const getResourceRoute = (type: string): string => {
  const routes: Record<string, string> = {
    adr: 'adrs',
    agent: 'agents',
    channel: 'channels',
    command: 'commands',
    container: 'containers',
    'data-product': 'data-products',
    dataProduct: 'data-products',
    diagram: 'diagrams',
    domain: 'domains',
    entity: 'entities',
    event: 'events',
    flow: 'flows',
    query: 'queries',
    service: 'services',
  };

  return routes[type] ?? `${type}s`;
};

const buildResourceUrl = (
  catalogUrl: string | undefined,
  consumer: SchemaConsumersResponse['consumers'][number]
): string | undefined => {
  const baseUrl = normalizeCatalogUrl(catalogUrl);

  if (!baseUrl || !consumer.id.trim() || !consumer.type.trim()) {
    return undefined;
  }

  const segments = ['docs', getResourceRoute(consumer.type), consumer.id, consumer.version].filter((segment) => segment.trim());
  return `${baseUrl}/${segments.map(encodeUrlSegment).join('/')}`;
};

const buildOwnerUrl = (catalogUrl: string | undefined, owner: string): string | undefined => {
  const baseUrl = normalizeCatalogUrl(catalogUrl);

  if (!baseUrl || !owner.trim()) {
    return undefined;
  }

  return `${baseUrl}/docs/teams/${encodeUrlSegment(owner)}`;
};

/** One scored schema paired with the catalog consumers it could break. */
export interface BreakingSchemaReport {
  breakingChange: BreakingChangeResponse;
  consumers: SchemaConsumersResponse['consumers'];
  diagram?: SchemaConsumersResponse['diagram'];
}

const formatOwner = (owner: string, catalogUrl: string | undefined): string => {
  const label = formatInlineText(owner);
  const url = buildOwnerUrl(catalogUrl, owner);

  return url ? formatMarkdownLink(label, url) : label;
};

const formatAffectedConsumer = (consumer: SchemaConsumersResponse['consumers'][number], catalogUrl?: string): string => {
  const summary = formatInlineText(consumer.summary || consumer.type);
  const resourceUrl = buildResourceUrl(catalogUrl, consumer);
  const resource = resourceUrl ? formatMarkdownLink(formatInlineText(consumer.id), resourceUrl) : formatInlineText(consumer.id);
  const owners =
    consumer.owners.length > 0
      ? `\n  - Owners: ${consumer.owners.map((owner) => formatOwner(owner, catalogUrl)).join(', ')}`
      : '';

  return `- ${resource} (${formatInlineText(consumer.version)}) - ${summary}
  - Reason: ${formatInlineText(consumer.reason)}${owners}`;
};

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

export const formatBreakingChangesComment = (reports: BreakingSchemaReport[], catalogUrl?: string): string => {
  const consumerCount = new Set(
    reports.flatMap(({ consumers }) => consumers.map((consumer) => `${consumer.type}:${consumer.id}`))
  ).size;
  const headline =
    consumerCount > 0
      ? `This pull request makes breaking changes to ${plural(reports.length, 'schema')} used by ${plural(consumerCount, 'consumer')} documented in EventCatalog. Check with their owners before merging.`
      : `This pull request makes breaking changes to ${plural(reports.length, 'schema')}. EventCatalog documents no consumers for ${reports.length === 1 ? 'it' : 'them'}.`;

  const sections = reports
    .map(({ breakingChange, consumers, diagram }) => {
      const changes =
        breakingChange.breakingChanges.length > 0
          ? breakingChange.breakingChanges
              .map(
                (change, index) =>
                  `**${index + 1}. ${formatInlineText(change.change)}**\n\n${formatCodeBlock(change.lines, 'diff')}`
              )
              .join('\n\n')
          : '- No specific lines were highlighted.';

      const consumersList =
        consumers.length > 0
          ? consumers.map((consumer) => formatAffectedConsumer(consumer, catalogUrl)).join('\n')
          : 'No consumers of this schema were found in the EventCatalog.';

      const flowDiagram = diagram?.trim() ? `**Impact diagram**\n\n${formatMermaidBlock(diagram)}\n\n` : '';

      return `#### ${formatInlineCode(breakingChange.fileName)}

**Confidence:** ${formatInlineText(breakingChange.confidence)}

${formatInlineText(breakingChange.summary)}

**Breaking changes**

${changes}

${flowDiagram}**Affected consumers**

${consumersList}`;
    })
    .join('\n\n');

  return `${BREAKING_CHANGES_COMMENT_MARKER}
### ⚠️ Breaking schema changes

${headline}

${sections}

<sub>EventCatalog Agents · Breaking Changes</sub>
`;
};

/**
 * Posts (or updates) the breaking-changes summary on the source pull request. Only call this when at
 * least one breaking schema change was found; the workflow logs and skips otherwise.
 */
export const postBreakingChangesSummary = async (
  config: ReviewConfig,
  reports: BreakingSchemaReport[]
): Promise<string | undefined> =>
  upsertPullRequestComment(config, BREAKING_CHANGES_COMMENT_MARKER, formatBreakingChangesComment(reports, config.catalogUrl));
