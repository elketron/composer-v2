// Shared representation for the flat markdown libraries (the knowledge
// notes, the agent workflows): the text helpers (slugs, one-liners,
// snippets), the frontmatter scanner, the flat `.md` path rule, the unique
// filename allocation, and the AND-scored token match both searches use.
// The stores keep the file I/O; the domain owns the text.

import { isAbsolute } from 'node:path';

export const MAX_SLUG_CHARS = 48;
export const MAX_SNIPPET_CHARS = 400;

/** Collapses whitespace and trims — one frontmatter line per field. */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** A filesystem-safe slug from a title (falls back when nothing survives). */
export function slugify(title: string, fallback: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-+$/g, '');
  return slug === '' ? fallback : slug;
}

/** An excerpt around the first (case-insensitive) token hit, ellipsised. */
export function snippetFor(body: string, token: string): string {
  const at = body.toLowerCase().indexOf(token);
  if (at < 0) return body.slice(0, MAX_SNIPPET_CHARS);
  const start = Math.max(0, at - 80);
  const excerpt = body.slice(start, start + MAX_SNIPPET_CHARS);
  return (start > 0 ? '…' : '') + excerpt;
}

/**
 * Scans a leading frontmatter block (`---` delimited) into its `key: value`
 * fields; the body is everything after the block. Null when the text has no
 * frontmatter (tolerant by design — files are the truth, human edits keep
 * reading).
 */
export function scanFrontmatter(raw: string): { fields: Map<string, string>; body: string } | null {
  if (!raw.startsWith('---')) return null;
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return null;
  const body = raw.slice(raw.indexOf('\n', end + 1) + 1);
  const fields = new Map<string, string>();
  for (const line of raw.slice(3, end).split('\n')) {
    const at = line.indexOf(':');
    if (at < 0) continue;
    fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return { fields, body };
}

/** A comma-separated frontmatter value as a clean string list. */
export function listValue(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
}

/** A path addresses one file of a flat library: a clean `.md` name. */
export function invalidLibraryPath(path: string, singular: string, plural: string): string | null {
  if (path.trim() === '') return `${singular} path is required`;
  if (isAbsolute(path) || /^[a-zA-Z]:/.test(path) || path.includes('/') || path.includes('\\')) {
    return `${singular} paths are plain file names of the flat library`;
  }
  if (!path.toLowerCase().endsWith('.md')) return `${plural} are .md files`;
  return null;
}

/** The first free `<slug>.md`, `-2`, `-3`, … against the taken names. */
export function uniqueSlugPath(taken: ReadonlySet<string>, slug: string): string {
  let candidate = `${slug}.md`;
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) {
    candidate = `${slug}-${n}.md`;
  }
  return candidate;
}

/**
 * AND-scored token match — a title hit weighs 4, a tag hit 3, a body hit 1,
 * and every token must match somewhere. Null when the text does not match.
 */
export function scoreText(
  tokens: readonly string[],
  title: string,
  tags: readonly string[],
  body: string,
): number | null {
  let score = 0;
  for (const token of tokens) {
    let tokenScore = 0;
    if (title.includes(token)) tokenScore += 4;
    if (tags.some((tag) => tag.includes(token))) tokenScore += 3;
    if (body.includes(token)) tokenScore += 1;
    if (tokenScore === 0) return null;
    score += tokenScore;
  }
  return score;
}
