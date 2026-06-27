import { Octokit } from 'octokit';
import type { ReviewConfig } from '@/src/config';
import { isPromptResponse, type BreakingChangeResponse, type SchemaConsumersResponse } from '@/src/review-output';

const COMMENT_MARKER = '<!-- eventcatalog-actions:pr-review -->';
const BREAKING_CHANGES_COMMENT_MARKER = '<!-- eventcatalog-actions:breaking-changes -->';
const MAX_RESULT_CHARS = 12000;

interface ReviewCommentInput {
  catalogPath: string;
  catalogPullRequestUrl?: string;
  changedFiles: string[];
  result: unknown;
}

const truncate = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n\n...truncated`;
};

const formatResult = (result: unknown): string => {
  if (typeof result === 'string') {
    return result;
  }

  if (result && typeof result === 'object') {
    if (isPromptResponse(result)) {
      return result.sourcePrSummary;
    }

    const record = result as Record<string, unknown>;
    const summary = record.sourcePrSummary || record.summary || record.message || record.text || record.output;

    if (typeof summary === 'string' && summary.trim()) {
      return summary;
    }

    return `\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
  }

  return String(result ?? 'No review output was returned.');
};

const formatReviewComment = ({ catalogPath, catalogPullRequestUrl, changedFiles, result }: ReviewCommentInput): string => {
  const files = changedFiles.length > 0 ? changedFiles.map((file) => `- \`${file}\``).join('\n') : '- No files reviewed';
  const summary = truncate(formatResult(result), MAX_RESULT_CHARS);
  const catalogPullRequest = catalogPullRequestUrl ? `\n\n## Catalog Pull Request\n\n${catalogPullRequestUrl}` : '';

  return `${COMMENT_MARKER}
# EventCatalog PR Review

## Summary

${summary}

## Files Reviewed

${files}

## Catalog

\`${catalogPath}\`
${catalogPullRequest}
`;
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

export const postPullRequestSummary = async (config: ReviewConfig, input: ReviewCommentInput): Promise<string | undefined> =>
  upsertPullRequestComment(config, COMMENT_MARKER, formatReviewComment(input));

/** One scored schema paired with the catalog consumers it could break. */
export interface BreakingSchemaReport {
  breakingChange: BreakingChangeResponse;
  consumers: SchemaConsumersResponse['consumers'];
}

const formatBreakingChangesComment = (reports: BreakingSchemaReport[]): string => {
  const sections = reports
    .map(({ breakingChange, consumers }) => {
      const changes =
        breakingChange.breakingChanges.length > 0
          ? breakingChange.breakingChanges
              .map((change) => `- ${change.change}\n\n  \`\`\`diff\n${change.lines}\n  \`\`\``)
              .join('\n')
          : '- No specific lines were highlighted.';

      const consumersList =
        consumers.length > 0
          ? consumers
              .map((consumer) => `- \`${consumer.id}\` (${consumer.type}) — ${consumer.reason}\n  - \`${consumer.path}\``)
              .join('\n')
          : '- No consumers of this schema were found in the EventCatalog.';

      return `### \`${breakingChange.fileName}\`

**Confidence:** ${breakingChange.confidence}

${breakingChange.summary}

#### Breaking changes

${changes}

#### Affected consumers

${consumersList}`;
    })
    .join('\n\n');

  return `${BREAKING_CHANGES_COMMENT_MARKER}
# EventCatalog Breaking Changes

The Breaking Changes agent detected schema changes in this pull request that may affect downstream consumers documented in your EventCatalog.

${sections}
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
  upsertPullRequestComment(config, BREAKING_CHANGES_COMMENT_MARKER, formatBreakingChangesComment(reports));
