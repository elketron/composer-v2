// The knowledge domain model (F2): a note owns its structured
// representation — title/tags frontmatter over the body — and its markdown
// rendering, instead of the pane rebuilding frontmatter and rendering raw
// wire JSON inline. The serializer mirrors the server's KnowledgeNote.

import { renderMarkdown } from '../markdown';

export class KnowledgeEntry {
  readonly path: string;
  readonly title: string;
  readonly tags: readonly string[];
  /** The body under the frontmatter (what search matches and the pane edits). */
  readonly body: string;
  /** The exact file text (the edit baseline). */
  readonly content: string;

  constructor(data: { path: string; title: string; tags: readonly string[]; body: string; content: string }) {
    this.path = data.path;
    this.title = data.title;
    this.tags = data.tags;
    this.body = data.body;
    this.content = data.content;
  }

  /** The side of the note the pane renders (frontmatter is structured). */
  renderedBody(): string {
    return renderMarkdown(this.body);
  }

  /** The exact file text a save writes: frontmatter over the trimmed body. */
  static serialize(title: string, tags: readonly string[], body: string): string {
    const oneTitle = title.trim().replace(/\s+/g, ' ');
    const frontmatter =
      `---\ntitle: ${oneTitle}\n` + (tags.length > 0 ? `tags: ${tags.join(', ')}\n` : '') + `---\n\n`;
    return `${frontmatter}${trimBody(body)}`;
  }

  /** A note body, trailing whitespace trimmed and one trailing newline. */
  static normalizeBody(body: string): string {
    return trimBody(body);
  }

  /** A comma list ("a, b") as clean tags. */
  static parseTags(raw: string): string[] {
    return raw
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '');
  }

  /** Joins tags for the structured tag input. */
  static joinTags(tags: readonly string[]): string {
    return tags.join(', ');
  }
}

/** A note body, trailing whitespace trimmed and one trailing newline. */
function trimBody(body: string): string {
  return body.replace(/\s+$/, '') + '\n';
}