// The git working-tree change helpers: the agent sessions' edited-file
// stats and per-file patches, computed against the project directory's
// repository. Tracked files diff against HEAD (the session's uncommitted
// edits); untracked files synthesize an added-file diff.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import type { FileObservation } from '../engine/types.js';

/** One file's computed patch (the run view's diff reader). */
export interface FilePatch {
  path: string;
  patch: string;
}

/** The per-file patch cap (a runaway diff cannot flood a response). */
const MAX_PATCH_CHARS = 120_000;

function exec(command: string, args: string[], cwd: string): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      // git signals "differences found" with exit 1 (no-index diffs); the
      // output still matters.
      resolve({ stdout: typeof stdout === 'string' ? stdout : '', code: error === null ? 0 : 1 });
    });
  });
}

/** Whether the path is tracked at HEAD (else it is new/untracked). */
async function isTracked(directory: string, path: string): Promise<boolean> {
  const { stdout } = await exec('git', ['ls-files', '--error-unmatch', '--', path], directory);
  return stdout.trim() !== '';
}

/** The file's line count (an untracked file's addition count). */
async function lineCount(directory: string, path: string): Promise<number> {
  try {
    const contents = await readFile(join(directory, path), 'utf8');
    const lines = contents.split('\n');
    return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  } catch {
    return 0;
  }
}

/** Minimal path joining without pulling node:path's platform quirks into callers. */
function join(directory: string, path: string): string {
  return `${directory.replace(/[\\/]+$/, '')}/${path.replace(/^[\\/]+/, '')}`;
}

/**
 * Fills the observations' addition/deletion counts from git (numstat for
 * tracked files; line counts for untracked ones). An observation the
 * engine already quantified rides unchanged; paths that git cannot see
 * (deleted, or not a repository) keep zero counts — the path list itself
 * still renders.
 */
export async function observeFileChanges(
  directory: string | undefined,
  files: readonly FileObservation[],
): Promise<FileObservation[]> {
  if (directory === undefined || directory === '') return [...files];
  const observed: FileObservation[] = [];
  for (const file of files) {
    if (file.additions !== 0 || file.deletions !== 0) {
      observed.push({ ...file });
      continue;
    }
    const tracked = await isTracked(directory, file.path);
    if (!tracked) {
      observed.push({ path: file.path, additions: await lineCount(directory, file.path), deletions: 0 });
      continue;
    }
    const { stdout } = await exec('git', ['diff', '--numstat', 'HEAD', '--', file.path], directory);
    const row = stdout.split('\n').find((line) => line.trim() !== '');
    const [additions, deletions] = row?.split('\t') ?? [];
    observed.push({
      path: file.path,
      additions: additions !== undefined && additions !== '-' ? Number(additions) || 0 : 0,
      deletions: deletions !== undefined && deletions !== '-' ? Number(deletions) || 0 : 0,
    });
  }
  return observed;
}

/**
 * The per-file working-tree patches (tracked: `git diff HEAD --`; untracked:
 * a synthesized added-file diff). A missing repository answers empty
 * patches — the file list still renders.
 */
export async function sessionFilePatches(
  directory: string | undefined,
  paths: readonly string[],
): Promise<FilePatch[]> {
  if (directory === undefined || directory === '') return paths.map((path) => ({ path, patch: '' }));
  const patches: FilePatch[] = [];
  for (const path of paths) {
    const tracked = await isTracked(directory, path);
    const { stdout } = tracked
      ? await exec('git', ['diff', 'HEAD', '--', path], directory)
      : await exec('git', ['diff', '--no-index', '--', '/dev/null', path], directory);
    patches.push({ path, patch: stdout.slice(0, MAX_PATCH_CHARS) });
  }
  return patches;
}
