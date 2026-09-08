import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { State } from '../../fold/index.js';
import { looksBinary } from '../../filesystem/binary.js';
import { isWithinRoot } from '../../filesystem/containment.js';
import { scoped } from './guards.js';
import type { ToolResult } from './types.js';

const MAX_LIST_ENTRIES = 500;
const MAX_READ_BYTES = 64 * 1024;

export function projectDirectory(state: State, scope: string[], projectId: string): { base: string } | ToolResult {
  const scopeError = scoped(scope, projectId);
  if (scopeError) return scopeError;
  const directory = state.projects.get(projectId)?.directory;
  if (directory === undefined) return { ok: false, error: `project ${projectId} has no directory set` };
  try {
    return { base: realpathSync(directory) };
  } catch {
    return { ok: false, error: `project ${projectId}'s directory does not exist` };
  }
}

function containedPath(base: string, path: string): string {
  const joined = isAbsolute(path) ? path : resolve(base, path);
  const real = realpathSync(joined);
  if (!isWithinRoot(base, real)) throw new Error('path escapes the project directory');
  return real;
}

function pathError(error: unknown, path: string): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('escapes')
    ? { ok: false, error: message }
    : { ok: false, error: `not a readable path: ${path}` };
}

export function listFiles(state: State, scope: string[], projectId: string, path: string): ToolResult {
  const found = projectDirectory(state, scope, projectId);
  if ('ok' in found) return found;
  let real: string;
  try {
    real = containedPath(found.base, path);
  } catch (error) {
    return pathError(error, path);
  }
  let entries;
  try {
    entries = readdirSync(real, { withFileTypes: true });
  } catch {
    return { ok: false, error: `not a readable directory: ${path}` };
  }
  const listing = entries
    .slice(0, MAX_LIST_ENTRIES)
    .map((entry) => {
      const kind = entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'dir' : 'file';
      let size: number | undefined;
      if (kind === 'file') {
        try {
          size = lstatSync(resolve(real, entry.name)).size;
        } catch {
          size = undefined;
        }
      }
      return { name: entry.name, kind, ...(size !== undefined ? { size } : {}) };
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  return {
    ok: true,
    content: JSON.stringify({ path, entries: listing, truncated: entries.length > MAX_LIST_ENTRIES }, null, 2),
  };
}

export function readFile(state: State, scope: string[], projectId: string, path: string): ToolResult {
  const found = projectDirectory(state, scope, projectId);
  if ('ok' in found) return found;
  let real: string;
  try {
    real = containedPath(found.base, path);
  } catch (error) {
    return pathError(error, path);
  }
  let stat;
  try {
    stat = statSync(real);
  } catch {
    return { ok: false, error: `not a readable file: ${path}` };
  }
  if (!stat.isFile()) return { ok: false, error: `not a file: ${path}` };
  const buffer = readFileSync(real);
  const head = buffer.subarray(0, 8192);
  if (looksBinary(head)) {
    return { ok: true, content: JSON.stringify({ path, binary: true, size: stat.size }, null, 2) };
  }
  return {
    ok: true,
    content: JSON.stringify(
      {
        path,
        size: stat.size,
        truncated: stat.size > MAX_READ_BYTES,
        text: buffer.subarray(0, MAX_READ_BYTES).toString('utf8'),
      },
      null,
      2,
    ),
  };
}
