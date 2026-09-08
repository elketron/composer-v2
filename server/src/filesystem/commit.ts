// The write-ahead compensation the file-backed domains share (SRV-003). A
// command that writes a file and then publishes its metadata event is a
// dual write: the filesystem and the event log cannot commit atomically.
// The repositories therefore return the file mutation plus a `rollback`
// that restores the prior file — the processor publishes the event(s) and,
// if any publication fails, runs the rollback so a failed command leaves
// neither the file nor the event behind.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** One file mutation plus the closure that undoes it. */
export interface Commit<T> {
  value: T;
  rollback: () => void;
}

/** A mutation's result: the value to publish, or a validation rejection. */
export type MutationResult<T> =
  | { ok: true; value: T; rollback: () => void }
  | { ok: false; error: string };

/**
 * Snapshots a file's current content so a later rollback can restore it (or
 * remove it when it did not exist). Best-effort: if the undo itself hits the
 * disk, the closure swallows it — the original error must win.
 */
export function captureFile(target: string): () => void {
  let existed = false;
  let content = '';
  try {
    if (statSync(target).isFile()) {
      existed = true;
      content = readFileSync(target, 'utf8');
    }
  } catch {
    // Missing (or not a regular file): the rollback simply removes it.
  }
  return () => {
    try {
      if (existed) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, 'utf8');
      } else {
        rmSync(target, { force: true });
      }
    } catch {
      // Rollback is best-effort; surface nothing so the original error wins.
    }
  };
}