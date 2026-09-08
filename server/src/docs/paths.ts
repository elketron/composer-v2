// The docs path rules and containment (Phase 9): the title a doc presents,
// the clean relative path rule, and the real-path containment proofs
// (symlink escapes reject). The file I/O lives in index.ts.

import { mkdirSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { docsRoot } from './index.js';

export type DocsResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** The title a doc presents: its first `#` heading, else its filename. */
export function docTitle(path: string, head: string): string {
  const match = /^#\s+(.+)$/m.exec(head);
  if (match && match[1] !== undefined && match[1].trim() !== '') return match[1].trim();
  return basename(path).replace(/\.md$/i, '');
}

/**
 * The slash-separated relative path a client may address: relative, `.md`
 * only, no `..` or dot segments, no traversal once resolved. Null = valid.
 */
export function invalidDocPath(path: string): string | null {
  if (path.trim() === '') return 'doc path is required';
  if (isAbsolute(path) || /^[a-zA-Z]:/.test(path)) return 'doc path must be relative';
  if (path.includes('\\')) return 'doc path must use / separators';
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return `doc path '${path}' is not a clean relative path`;
  }
  if (!path.toLowerCase().endsWith('.md')) return 'docs are .md files';
  return null;
}

/**
 * The absolute target path for a relative doc path, containment-proven:
 * the deepest already-existing ancestor is real-pathed (a symlinked
 * segment pointing outside rejects), the remainder resolves plainly, and
 * the final path must stay under the docs root. Creates the root if
 * missing (a first save plants it).
 */
export function resolveTarget(projectDirectory: string, path: string): DocsResult<string> {
  const root = docsRoot(projectDirectory);
  try {
    mkdirSync(root, { recursive: true });
  } catch {
    return { ok: false, error: `the docs directory of ${projectDirectory} is not writable` };
  }
  const rootReal = realpathSync(root);
  const segments = path.split('/');
  let existing = rootReal;
  let depth = 0;
  while (depth < segments.length - 1) {
    const candidate = join(existing, segments[depth]!);
    try {
      existing = realpathSync(candidate);
    } catch {
      break; // Not created yet — the remaining path is plain resolution.
    }
    depth += 1;
    if (existing !== rootReal && !existing.startsWith(rootReal + sep)) {
      return { ok: false, error: 'path escapes the docs directory' };
    }
  }
  const target = join(existing, ...segments.slice(depth));
  if (!target.startsWith(rootReal + sep)) {
    return { ok: false, error: 'path escapes the docs directory' };
  }
  return { ok: true, value: target };
}

/**
 * Resolves an existing path through the real filesystem inside the docs
 * root (the assistant tools' containedPath, rooted at docs/). Escapes and
 * missing roots reject.
 */
export function containedExisting(projectDirectory: string, path: string): DocsResult<string> {
  const root = docsRoot(projectDirectory);
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return { ok: false, error: `project has no docs directory yet` };
  }
  let real: string;
  try {
    real = realpathSync(resolve(rootReal, path));
  } catch {
    return { ok: false, error: `not a readable doc: ${path}` };
  }
  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    return { ok: false, error: 'path escapes the docs directory' };
  }
  return { ok: true, value: real };
}

