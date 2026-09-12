// The git working-tree change helpers: the agent sessions' edited-file
// stats and per-file patches, computed against the project directory's
// repository. Tracked files diff against HEAD (the session's uncommitted
// edits); untracked files synthesize an added-file diff. The turn-boundary
// snapshot pair (snapshotWorkingTree + changedFilesSince) observes the
// files a turn changed, whatever tool created them.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import type { FileObservation } from '../engine/types.js';

/** One file's computed patch (the run view's diff reader). */
export interface FilePatch {
  path: string;
  patch: string;
}

/** The per-file patch cap (a runaway diff cannot flood a response). */
const MAX_PATCH_CHARS = 120_000;

function exec(
  command: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd,
        maxBuffer: 16 * 1024 * 1024,
        ...(env !== undefined ? { env: { ...process.env, ...env } } : {}),
      },
      (error, stdout) => {
        // git signals "differences found" with exit 1 (no-index diffs); the
        // output still matters.
        resolve({ stdout: typeof stdout === 'string' ? stdout : '', code: error === null ? 0 : 1 });
      },
    );
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

/** A working-tree snapshot token (a tree object, opaque to callers). */
export type WorkingTreeSnapshot = string;

/** The snapshot's tree-hash shape (sha1 and sha256 repositories). */
const TREE_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Snapshots the directory's working tree — tracked and untracked files,
 * .gitignore respected — into a tree object. The snapshot rides a throwaway
 * index (GIT_INDEX_FILE in the OS temp dir), so the user's index and
 * working tree are untouched. Null when git is missing, the directory is
 * outside a repository, or the snapshot fails.
 */
export async function snapshotWorkingTree(
  directory: string,
): Promise<WorkingTreeSnapshot | null> {
  const index = join(tmpdir(), `composer-tree-${randomUUID()}`);
  try {
    const env = { GIT_INDEX_FILE: index };
    const add = await exec('git', ['add', '-A', '--'], directory, env);
    if (add.code !== 0) return null;
    const write = await exec('git', ['write-tree'], directory, env);
    const tree = write.stdout.trim();
    return write.code === 0 && TREE_PATTERN.test(tree) ? tree : null;
  } catch {
    return null;
  } finally {
    await rm(index, { force: true }).catch(() => undefined);
  }
}

/**
 * The working-tree files changed since the snapshot, with numstat counts
 * (binary and submodule rows count zero). Paths are relative to the
 * directory (git's --relative). Empty when nothing changed, the snapshot
 * is stale, or git fails — a missing observation is better than a wrong
 * one.
 */
export async function changedFilesSince(
  directory: string,
  before: WorkingTreeSnapshot,
): Promise<FileObservation[]> {
  const after = await snapshotWorkingTree(directory);
  if (after === null || after === before) return [];
  const { stdout, code } = await exec(
    'git',
    ['diff-tree', '-r', '--numstat', '--no-renames', '--relative', '-z', before, after],
    directory,
  );
  if (code !== 0) return [];
  const files: FileObservation[] = [];
  for (const row of stdout.split('\0')) {
    if (row === '') continue;
    const [additions, deletions, path] = row.split('\t');
    if (path === undefined || path === '') continue;
    const count = (field: string | undefined): number => {
      const parsed = field === undefined ? Number.NaN : Number(field);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    files.push({ path, additions: count(additions), deletions: count(deletions) });
  }
  return files;
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
