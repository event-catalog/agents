import { Octokit } from 'octokit';
import type { ReviewConfig } from '@/src/config';
import { isPromptResponse } from '@/src/review-output';

const COMMENT_MARKER = '<!-- eventcatalog-actions:pr-review -->';
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

export const postPullRequestSummary = async (config: ReviewConfig, input: ReviewCommentInput): Promise<string | undefined> => {
  if (!config.github) {
    console.error('[eventcatalog:github] No GitHub PR context found; skipping pull request comment.');
    return undefined;
  }

  const { owner, repo, prNumber, token } = config.github;
  const octokit = new Octokit({ auth: token });
  const body = formatReviewComment(input);

  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });

  const existingComment = comments.find((comment) => comment.body?.includes(COMMENT_MARKER));

  if (existingComment) {
    const { data } = await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existingComment.id,
      body,
    });

    console.error(`[eventcatalog:github] Updated pull request summary: ${data.html_url}`);
    return data.html_url;
  }

  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });

  console.error(`[eventcatalog:github] Created pull request summary: ${data.html_url}`);
  return data.html_url;
};
