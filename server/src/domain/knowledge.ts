// The knowledge note (Phase 9): one markdown note with a small frontmatter
// (title, tags). The class owns the note's text representation — parsing a
// file (with filename fallbacks) and serializing a new note's exact file
// text — plus its scored match against a search query. The store
// (src/knowledge.ts) keeps the file I/O; this is the repr.

import { basename } from 'node:path';
import type { KnowledgeEntryInfo } from '../wire/models.js';
import { listValue, oneLine, scanFrontmatter, scoreText, snippetFor } from './markdown.js';

export class KnowledgeNote {
  readonly path: string;
  readonly title: string;
  readonly tags: readonly string[];
  /** The body under the frontmatter (search/snippets). */
  readonly body: string;

  private constructor(path: string, title: string, tags: readonly string[], body: string) {
    this.path = path;
    this.title = title;
    this.tags = tags;
    this.body = body;
  }

  /**
   * Parses one note's file text. The title falls back to the filename;
   * the frontmatter's title and tags win when present.
   */
  static fromFile(path: string, raw: string): KnowledgeNote {
    const scanned = scanFrontmatter(raw);
    if (scanned === null) {
      return new KnowledgeNote(path, basename(path).replace(/\.md$/i, ''), [], raw);
    }
    let title = basename(path).replace(/\.md$/i, '');
    const frontTitle = scanned.fields.get('title');
    if (frontTitle !== undefined && frontTitle !== '') title = frontTitle;
    return new KnowledgeNote(path, title, listValue(scanned.fields.get('tags')), scanned.body);
  }

  /** The wire metadata (size/updatedAt ride the store's stat). */
  info(): KnowledgeEntryInfo {
    return { path: this.path, title: this.title, tags: [...this.tags], size: 0, updatedAt: '' };
  }

  /**
   * The exact file text a new note is written as: title/tags frontmatter
   * over the trimmed content.
   */
  static toMarkdown(parts: { title: string; tags?: string[]; content: string }): string {
    const title = oneLine(parts.title);
    const tags = (parts.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag !== '');
    const frontmatter =
      `---\ntitle: ${title}\n` +
      (tags.length > 0 ? `tags: ${tags.join(', ')}\n` : '') +
      `---\n\n`;
    return `${frontmatter}${parts.content.trim()}\n`;
  }

  /**
   * The note's AND-scored match for the query tokens — a title hit weighs
   * 4, a tag hit 3, a body hit 1, and every token must match somewhere.
   * Null when the note does not match.
   */
  score(tokens: readonly string[]): number | null {
    return scoreText(
      tokens,
      this.title.toLowerCase(),
      this.tags.map((tag) => tag.toLowerCase()),
      this.body.toLowerCase(),
    );
  }

  /** A body excerpt around the first token hit — enough for a note. */
  snippet(token: string): string {
    return snippetFor(this.body, token);
  }
}
