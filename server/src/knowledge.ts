// The knowledge library (Phase 9): markdown notes with a small
// frontmatter (title, tags) under the composer data dir — global,
// project-agnostic, outside any repository. Files are the truth: the
// store reads, writes, and searches them; the processor publishes
// metadata events around its writes. The agent reaches it through the
// MCP tools (knowledge_search, knowledge_save); the desktop edits the
// same files through the knowledge commands.

import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import type { KnowledgeEntryInfo } from './wire/models.js';

const KNOWLEDGE_DIRNAME = 'knowledge';
/** 256 KiB per note; knowledge is notes, not file dumps. */
export const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_RESULTS = 10;
const MAX_SNIPPET_CHARS = 400;
const MAX_SLUG_CHARS = 48;

export type KnowledgeResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ParsedEntry {
  info: KnowledgeEntryInfo;
  /** The body under the frontmatter (search/snippets). */
  body: string;
  /** The exact file text (the edit baseline; writes take this back). */
  content: string;
}

export class KnowledgeStore {
  private readonly root: string;

  constructor(dataDir: string) {
    this.root = join(dataDir, KNOWLEDGE_DIRNAME);
  }

  /** Every entry, sorted by path (a missing library lists empty). */
  list(): KnowledgeEntryInfo[] {
    const entries: KnowledgeEntryInfo[] = [];
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      return entries;
    }
    for (const name of names.slice(0, MAX_LIST_ENTRIES)) {
      if (!name.toLowerCase().endsWith('.md')) continue;
      const info = this.statEntry(name);
      if (info !== null) entries.push(info);
    }
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** One entry's file text (frontmatter included — the edit baseline). */
  read(path: string): KnowledgeResult<ParsedEntry> {
    const invalid = invalidKnowledgePath(path);
    if (invalid !== null) return { ok: false, error: invalid };
    let raw: string;
    try {
      raw = readFileSync(this.resolveContained(path)).toString('utf8');
    } catch {
      return { ok: false, error: `not a readable note: ${path}` };
    }
    const parsed = parseEntry(path, raw);
    return { ok: true, value: { info: parsed.info, body: parsed.body, content: raw } };
  }

  /** Writes the exact file text (the desktop's edit flow). */
  saveToFile(path: string, content: string): KnowledgeResult<KnowledgeEntryInfo> {
    const invalid = invalidKnowledgePath(path);
    if (invalid !== null) return { ok: false, error: invalid };
    const tooBig = checkSize(content);
    if (tooBig !== null) return tooBig;
    return this.writeFile(path, content);
  }

  /**
   * Creates a note from parts (the agent's `knowledge_save`): the store
   * builds the frontmatter and a unique slug filename, so an agent can
   * never overwrite by accident. Returns the saved path.
   */
  createEntry(parts: { title: string; tags?: string[]; content: string }): KnowledgeResult<KnowledgeEntryInfo & { path: string }> {
    const title = parts.title.trim();
    if (title === '') return { ok: false, error: 'a knowledge note needs a title' };
    const tooBig = checkSize(parts.content);
    if (tooBig !== null) return tooBig;
    const tags = (parts.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag !== '');
    const frontmatter =
      `---\ntitle: ${oneLine(title)}\n` +
      (tags.length > 0 ? `tags: ${tags.join(', ')}\n` : '') +
      `---\n\n`;
    const path = this.uniquePath(slugify(title));
    return this.writeFile(path, `${frontmatter}${parts.content.trim()}\n`);
  }

  /** Deletes one note; it must exist. */
  delete(path: string): KnowledgeResult<null> {
    const invalid = invalidKnowledgePath(path);
    if (invalid !== null) return { ok: false, error: invalid };
    try {
      statSync(this.resolveContained(path));
    } catch {
      return { ok: false, error: `not a readable note: ${path}` };
    }
    try {
      rmSync(this.resolveContained(path));
    } catch {
      return { ok: false, error: `note '${path}' could not be deleted` };
    }
    return { ok: true, value: null };
  }

  /**
   * Scored search (AND over whitespace-split tokens): a title match
   * weighs 4, a tag match 3, a body match 1. Results carry a body
   * snippet — enough for a note, never a file dump.
   */
  search(query: string): Array<{ info: KnowledgeEntryInfo; snippet: string; score: number }> {
    const tokens = query.toLowerCase().split(/\s+/).filter((token) => token !== '');
    if (tokens.length === 0) return [];
    const results: Array<{ info: KnowledgeEntryInfo; snippet: string; score: number }> = [];
    for (const entry of this.list()) {
      const parsed = this.read(entry.path);
      if (!parsed.ok) continue;
      const { info, body } = parsed.value;
      const title = info.title.toLowerCase();
      const tags = info.tags.map((tag) => tag.toLowerCase());
      const haystack = body.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        let tokenScore = 0;
        if (title.includes(token)) tokenScore += 4;
        if (tags.some((tag) => tag.includes(token))) tokenScore += 3;
        if (haystack.includes(token)) tokenScore += 1;
        if (tokenScore === 0) {
          score = 0; // AND semantics: every token must match somewhere.
          break;
        }
        score += tokenScore;
      }
      if (score === 0) continue;
      results.push({ info, snippet: snippetFor(body, tokens[0]!), score });
    }
    return results
      .sort((a, b) => b.score - a.score || a.info.path.localeCompare(b.info.path))
      .slice(0, MAX_SEARCH_RESULTS);
  }

  // ---- Internals ----

  private statEntry(name: string): KnowledgeEntryInfo | null {
    const file = join(this.root, name);
    try {
      const stat = statSync(file);
      if (!stat.isFile()) return null;
      const parsed = parseEntry(name, readFileSync(file).toString('utf8'));
      return { ...parsed.info, size: stat.size, updatedAt: stat.mtime.toISOString() };
    } catch {
      return null;
    }
  }

  private writeFile(path: string, content: string): KnowledgeResult<KnowledgeEntryInfo> {
    try {
      mkdirSync(this.root, { recursive: true });
      // The library is flat: resolve the filename against the real root so
      // a planted symlink cannot turn a write into an escape.
      const rootReal = realpathSync(this.root);
      const target = resolve(rootReal, path);
      if (!target.startsWith(rootReal + sep)) {
        return { ok: false, error: 'path escapes the knowledge library' };
      }
      writeFileSync(target, content, 'utf8');
      const stat = statSync(target);
      const parsed = parseEntry(path, content);
      return {
        ok: true,
        value: { ...parsed.info, size: stat.size, updatedAt: stat.mtime.toISOString() },
      };
    } catch {
      return { ok: false, error: `note '${path}' could not be written` };
    }
  }

  private resolveContained(path: string): string {
    const rootReal = realpathSync(this.root);
    const target = resolve(rootReal, path);
    if (target !== rootReal && !target.startsWith(rootReal + sep)) {
      throw new Error('path escapes the knowledge library');
    }
    return target;
  }

  private uniquePath(slug: string): string {
    const taken = new Set(this.list().map((entry) => entry.path.toLowerCase()));
    let candidate = `${slug}.md`;
    for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) {
      candidate = `${slug}-${n}.md`;
    }
    return candidate;
  }
}

/** A knowledge path addresses one file of the flat library: a clean `.md` name. */
export function invalidKnowledgePath(path: string): string | null {
  if (path.trim() === '') return 'knowledge path is required';
  if (isAbsolute(path) || /^[a-zA-Z]:/.test(path) || path.includes('/') || path.includes('\\')) {
    return 'knowledge paths are plain file names of the flat library';
  }
  if (!path.toLowerCase().endsWith('.md')) return 'knowledge notes are .md files';
  return null;
}

/** Parses frontmatter (title, tags) with filename fallbacks. */
function parseEntry(path: string, raw: string): { info: KnowledgeEntryInfo; body: string } {
  let title = basename(path).replace(/\.md$/i, '');
  let tags: string[] = [];
  let body = raw;
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3);
    if (end >= 0) {
      const head = raw.slice(3, end);
      body = raw.slice(raw.indexOf('\n', end + 1) + 1);
      for (const line of head.split('\n')) {
        const at = line.indexOf(':');
        if (at < 0) continue;
        const key = line.slice(0, at).trim();
        const value = line.slice(at + 1).trim();
        if (key === 'title' && value !== '') title = value;
        if (key === 'tags') {
          tags = value.split(',').map((tag) => tag.trim()).filter((tag) => tag !== '');
        }
      }
    }
  }
  return { info: { path, title, tags, size: 0, updatedAt: '' }, body };
}

function snippetFor(body: string, token: string): string {
  const at = body.toLowerCase().indexOf(token);
  if (at < 0) return body.slice(0, MAX_SNIPPET_CHARS);
  const start = Math.max(0, at - 80);
  const excerpt = body.slice(start, start + MAX_SNIPPET_CHARS);
  return (start > 0 ? '…' : '') + excerpt;
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-+$/g, '');
  return slug === '' ? 'note' : slug;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function checkSize(content: string): KnowledgeResult<never> | null {
  if (Buffer.byteLength(content, 'utf8') > MAX_ENTRY_BYTES) {
    return { ok: false, error: `note exceeds the ${Math.floor(MAX_ENTRY_BYTES / 1024)} KiB limit` };
  }
  return null;
}
