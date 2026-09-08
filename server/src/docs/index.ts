// The docs file layer (Phase 9): markdown files under the project's
// `docs/` directory. Files are the truth — the processor performs these
// writes inside the command path and publishes metadata events; content
// reaches clients over REST reads. All paths are slash-separated and
// relative to `docs/`; every access enforces real-path containment
// (symlink escapes reject), the same rule the assistant file tools use.
// The path rules and containment live in paths.ts; this module is the I/O.

import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DocInfo } from '../wire/models.js';
import { looksBinary } from '../filesystem/binary.js';
import { captureFile, type MutationResult } from '../filesystem/commit.js';
import { writeTextFileContained } from '../filesystem/containment.js';
import { isContainmentFailure, StorageError } from '../filesystem/errors.js';
import { MAX_DOC_BYTES, MAX_LIST_ENTRIES } from './constants.js';
import { docTitle, containedExisting, resolveTarget, invalidDocPath, type DocsResult } from './paths.js';
import { docsRoot } from './root.js';

export { DOCS_DIRNAME, MAX_DOC_BYTES, MAX_LIST_ENTRIES } from './constants.js';
export { docTitle, invalidDocPath, type DocsResult } from './paths.js';
export { docsRoot } from './root.js';

/**
 * Lists every markdown doc under the project's docs root (recursive,
 * symlink-free, sorted by path). A missing docs root lists empty — no
 * docs yet is not an error.
 */
export function listDocs(projectDirectory: string): DocsResult<DocInfo[]> {
  const root = docsRoot(projectDirectory);
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return { ok: true, value: [] };
  }
  const docs: DocInfo[] = [];
  const walk = (real: string, rel: string): void => {
    if (docs.length >= MAX_LIST_ENTRIES) return;
    let entries;
    try {
      entries = readdirSync(real, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (docs.length >= MAX_LIST_ENTRIES) return;
      if (entry.isSymbolicLink()) continue;
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const realPath = join(real, entry.name);
      if (entry.isDirectory()) {
        walk(realPath, relPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      const info = statInfo(realPath, relPath);
      if (info !== null) docs.push(info);
    }
  };
  walk(rootReal, '');
  docs.sort((a, b) => a.path.localeCompare(b.path));
  return { ok: true, value: docs };
}

/** Reads one doc's content (text only, size-capped). */
export function readDoc(projectDirectory: string, path: string): DocsResult<{ info: DocInfo; content: string }> {
  const invalid = invalidDocPath(path);
  if (invalid !== null) return { ok: false, error: invalid };
  const contained = containedExisting(projectDirectory, path);
  if (!contained.ok) return contained;
  const real = contained.value;
  let stat;
  try {
    stat = statSync(real);
  } catch {
    return { ok: false, error: `not a readable doc: ${path}` };
  }
  if (!stat.isFile()) return { ok: false, error: `not a file: ${path}` };
  if (stat.size > MAX_DOC_BYTES) {
    return { ok: false, error: `doc exceeds the ${Math.floor(MAX_DOC_BYTES / 1024)} KiB limit` };
  }
  const buffer = readFileSync(real);
  const head = buffer.subarray(0, 8192);
  if (looksBinary(head)) {
    return { ok: false, error: `not a text file: ${path}` };
  }
  const content = buffer.toString('utf8');
  return {
    ok: true,
    value: {
      info: {
        path,
        title: docTitle(path, content),
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
      },
      content,
    },
  };
}

/**
 * Creates or overwrites one doc (the processor's command path). The target
 * may not exist yet: containment is proven against the deepest existing
 * ancestor so a fresh tree cannot be planted outside the docs root.
 */
export function saveDoc(
  projectDirectory: string,
  path: string,
  content: string,
): MutationResult<DocInfo> {
  const invalid = invalidDocPath(path);
  if (invalid !== null) return { ok: false, error: invalid };
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_DOC_BYTES) {
    return { ok: false, error: `doc exceeds the ${Math.floor(MAX_DOC_BYTES / 1024)} KiB limit` };
  }
  const target = resolveTarget(projectDirectory, path);
  if (!target.ok) return target;
  const rollback = captureFile(target.value);
  try {
    mkdirSync(dirname(target.value), { recursive: true });
    writeTextFileContained(docsRoot(projectDirectory), target.value, content);
  } catch (error) {
    if (isContainmentFailure(error)) {
      return { ok: false, error: `doc '${path}' could not be written` };
    }
    throw new StorageError(`doc '${path}' could not be written`);
  }
  const stat = statSync(target.value);
  return {
    ok: true,
    value: {
      path,
      title: docTitle(path, content),
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
    },
    rollback,
  };
}

/**
 * Renames one doc in one transaction (the processor's command path): a
 * single `renameSync` inside the docs root, published as docSaved(new) +
 * docDeleted(old). The target must not exist — renames never overwrite.
 */
export function renameDoc(
  projectDirectory: string,
  path: string,
  to: string,
): MutationResult<DocInfo> {
  const invalidFrom = invalidDocPath(path);
  if (invalidFrom !== null) return { ok: false, error: invalidFrom };
  const invalidTo = invalidDocPath(to);
  if (invalidTo !== null) return { ok: false, error: invalidTo };
  const source = containedExisting(projectDirectory, path);
  if (!source.ok) return source;
  const target = resolveTarget(projectDirectory, to);
  if (!target.ok) return target;
  try {
    if (statSync(target.value).isFile()) {
      return { ok: false, error: `doc '${to}' already exists` };
    }
  } catch {
    // Not there — the target is free.
  }
  try {
    mkdirSync(dirname(target.value), { recursive: true });
    renameSync(source.value, target.value);
  } catch (error) {
    if (isContainmentFailure(error)) {
      return { ok: false, error: `doc '${path}' could not be renamed to '${to}'` };
    }
    throw new StorageError(`doc '${path}' could not be renamed to '${to}'`);
  }
  const info = statInfo(target.value, to);
  if (info === null) {
    return { ok: false, error: `doc '${to}' could not be read back` };
  }
  const rollback = () => {
    try {
      renameSync(target.value, source.value);
    } catch {
      // Best-effort undo; the original error must win.
    }
  };
  return { ok: true, value: info, rollback };
}

/** Deletes one doc (the processor's command path); it must exist. */
export function deleteDoc(projectDirectory: string, path: string): MutationResult<null> {
  const invalid = invalidDocPath(path);
  if (invalid !== null) return { ok: false, error: invalid };
  const contained = containedExisting(projectDirectory, path);
  if (!contained.ok) return contained;
  const rollback = captureFile(contained.value);
  try {
    rmSync(contained.value);
  } catch (error) {
    if (isContainmentFailure(error)) {
      return { ok: false, error: `doc '${path}' could not be deleted` };
    }
    throw new StorageError(`doc '${path}' could not be deleted`);
  }
  return { ok: true, value: null, rollback };
}

// ---- Internals ----

function statInfo(realPath: string, relPath: string): DocInfo | null {
  try {
    const stat = statSync(realPath);
    if (!stat.isFile()) return null;
    let head = '';
    try {
      const handle = openSync(realPath, 'r');
      try {
        const buffer = Buffer.alloc(4096);
        const read = readSync(handle, buffer, 0, buffer.length, 0);
        head = buffer.subarray(0, read).toString('utf8');
      } finally {
        closeSync(handle);
      }
    } catch {
      head = '';
    }
    return {
      path: relPath,
      title: docTitle(relPath, head),
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}
