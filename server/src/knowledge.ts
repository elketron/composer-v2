// The knowledge library (Phase 9): markdown notes with a small
// frontmatter (title, tags) under the composer data dir — global,
// project-agnostic, outside any repository. Files are the truth: the
// store reads, writes, and searches them; the processor publishes
// metadata events around its writes. The agent reaches it through the
// MCP tools (knowledge_search, knowledge_save); the desktop edits the
// same files through the knowledge commands. The note's text
// representation (frontmatter parse, serialization, scored match) lives
// on the domain object (domain/knowledge.ts); this store is the I/O.

import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { KnowledgeEntryInfo } from './wire/models.js';
import { invalidLibraryPath, slugify, uniqueSlugPath } from './domain/markdown.js';
import { KnowledgeNote } from './domain/knowledge.js';
import { captureFile, type MutationResult } from './filesystem/commit.js';
import { isWithinRoot, writeTextFileContained } from './filesystem/containment.js';
import { isContainmentFailure, StorageError } from './filesystem/errors.js';

const KNOWLEDGE_DIRNAME = 'knowledge';
/** 256 KiB per note; knowledge is notes, not file dumps. */
export const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_RESULTS = 10;

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
    const note = KnowledgeNote.fromFile(path, raw);
    return { ok: true, value: { info: note.info(), body: note.body, content: raw } };
  }

  /** Writes the exact file text (the desktop's edit flow). */
  saveToFile(path: string, content: string): MutationResult<KnowledgeEntryInfo> {
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
  createEntry(parts: { title: string; tags?: string[]; content: string }): MutationResult<KnowledgeEntryInfo> {
    const title = parts.title.trim();
    if (title === '') return { ok: false, error: 'a knowledge note needs a title' };
    const tooBig = checkSize(parts.content);
    if (tooBig !== null) return tooBig;
    const content = KnowledgeNote.toMarkdown(parts);
    const taken = new Set(this.list().map((entry) => entry.path.toLowerCase()));
    const path = uniqueSlugPath(taken, slugify(title, 'note'));
    return this.writeFile(path, content);
  }

  /** Deletes one note; it must exist. */
  delete(path: string): MutationResult<null> {
    const invalid = invalidKnowledgePath(path);
    if (invalid !== null) return { ok: false, error: invalid };
    let target: string;
    try {
      target = this.resolveContained(path);
      statSync(target);
    } catch {
      return { ok: false, error: `not a readable note: ${path}` };
    }
    const rollback = captureFile(target);
    try {
      rmSync(target);
    } catch (error) {
      if (isContainmentFailure(error)) {
        return { ok: false, error: `note '${path}' could not be deleted` };
      }
      throw new StorageError(`note '${path}' could not be deleted`);
    }
    return { ok: true, value: null, rollback };
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
      const note = KnowledgeNote.fromFile(entry.path, parsed.value.content);
      const score = note.score(tokens);
      if (score === null) continue;
      results.push({ info: parsed.value.info, snippet: note.snippet(tokens[0]!), score });
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
      const note = KnowledgeNote.fromFile(name, readFileSync(file).toString('utf8'));
      return { ...note.info(), size: stat.size, updatedAt: stat.mtime.toISOString() };
    } catch {
      return null;
    }
  }

  private writeFile(path: string, content: string): MutationResult<KnowledgeEntryInfo> {
    let rootReal: string;
    try {
      mkdirSync(this.root, { recursive: true });
      rootReal = realpathSync(this.root);
    } catch (error) {
      if (isContainmentFailure(error)) {
        return { ok: false, error: `note '${path}' could not be written` };
      }
      throw new StorageError(`note '${path}' could not be written`);
    }
    // The library is flat: resolve the filename against the real root so
    // a planted symlink cannot turn a write into an escape.
    const target = resolve(rootReal, path);
    if (!isWithinRoot(rootReal, target) || target === rootReal) {
      return { ok: false, error: 'path escapes the knowledge library' };
    }
    const rollback = captureFile(target);
    try {
      writeTextFileContained(rootReal, target, content);
    } catch (error) {
      if (isContainmentFailure(error)) {
        return { ok: false, error: `note '${path}' could not be written` };
      }
      throw new StorageError(`note '${path}' could not be written`);
    }
    const stat = statSync(target);
    const note = KnowledgeNote.fromFile(path, content);
    return {
      ok: true,
      value: { ...note.info(), size: stat.size, updatedAt: stat.mtime.toISOString() },
      rollback,
    };
  }

  private resolveContained(path: string): string {
    const rootReal = realpathSync(this.root);
    const target = resolve(rootReal, path);
    if (!isWithinRoot(rootReal, target)) {
      throw new Error('path escapes the knowledge library');
    }
    return target;
  }
}

/** A knowledge path addresses one file of the flat library: a clean `.md` name. */
export function invalidKnowledgePath(path: string): string | null {
  return invalidLibraryPath(path, 'knowledge', 'knowledge notes');
}

function checkSize(content: string): { ok: false; error: string } | null {
  if (Buffer.byteLength(content, 'utf8') > MAX_ENTRY_BYTES) {
    return { ok: false, error: `note exceeds the ${Math.floor(MAX_ENTRY_BYTES / 1024)} KiB limit` };
  }
  return null;
}
