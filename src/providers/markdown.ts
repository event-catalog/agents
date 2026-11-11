/**
 * The comment and pull request markdown is written for GitHub. Azure DevOps and Bitbucket render
 * markdown but not raw HTML (they would show `<sub>` and `<!-- -->` as text) or GitHub alerts, so their
 * providers convert those with these helpers. Mermaid diagrams are left as they are: neither renders
 * them in pull requests, so they show as code blocks.
 */

/**
 * Replaces the line that marks the agent's comment (`<!-- eventcatalog-actions:adr-compliance -->`)
 * with what `replacement` returns for its id (`eventcatalog-actions:adr-compliance`).
 */
export const replaceCommentMarker = (markdown: string, replacement: (id: string) => string): string =>
  markdown.replace(/^<!-- (eventcatalog-actions:[\w-]+) -->\n?/gm, (_, id: string) => replacement(id));

/** The id inside a comment marker: `eventcatalog-actions:adr-compliance`. */
export const markerId = (marker: string): string => marker.replace(/^<!--\s*|\s*-->$/g, '');

/** Replaces GitHub alerts and `<sub>` with plain markdown. Leaves the comment marker alone. */
export const withoutGithubExtensions = (markdown: string): string =>
  markdown
    .replace(
      /^> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\n> /gm,
      (_, kind: string) => `> **${kind.charAt(0)}${kind.slice(1).toLowerCase()}:** `
    )
    .replace(/<sub>([\s\S]*?)<\/sub>/g, (_, text: string) => `_${text.trim()}_`);

/** Shortens text to `max` characters, ending with a note that it was cut. */
export const fitLength = (value: string, max: number, note: string): string =>
  value.length <= max ? value : `${value.slice(0, max - note.length).trimEnd()}${note}`;

const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * Shortens markdown to `max` characters at the end of a paragraph (or else a line), so the cut doesn't
 * land inside a table row or a link, and closes a code block it would leave open. Ends with `note`.
 */
export const fitMarkdown = (markdown: string, max: number, note: string): string => {
  if (markdown.length <= max) return markdown;

  // Leave room for the note and a closing fence.
  const budget = max - note.length - 8;
  const slice = markdown.slice(0, budget);
  // Prefer the end of a paragraph, then the end of a line, as long as that keeps most of the text.
  const paragraphEnd = slice.lastIndexOf('\n\n');
  const lineEnd = slice.lastIndexOf('\n');
  const cut = paragraphEnd > budget / 2 ? paragraphEnd : lineEnd > budget / 2 ? lineEnd : budget;
  let kept = slice.slice(0, cut).trimEnd();

  let openFence: string | undefined;
  for (const line of kept.split('\n')) {
    const fence = line.match(FENCE)?.[1];
    if (!fence) continue;
    if (!openFence) openFence = fence;
    else if (fence[0] === openFence[0] && fence.length >= openFence.length) openFence = undefined;
  }
  if (openFence) kept = `${kept}\n${openFence}`;

  return `${kept}${note}`;
};
