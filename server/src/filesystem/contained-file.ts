// The flat-directory file protocol (SRV-015): the write and delete steps the
// knowledge and workflow libraries share — create and prove the root, resolve
// a flat name inside it, write through the O_NOFOLLOW writer, remove — each
// step classifying a containment rejection (a planted symlink) from a real
// `StorageError`, and returning the rollback the dual-write compensation
// (SRV-003) needs. Parameterized by the noun ('note' / 'workflow') and the
// library's name for the messages.

import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { captureFile } from './commit.js';
import { isWithinRoot, writeTextFileContained } from './containment.js';
import { isContainmentFailure, StorageError } from './errors.js';

/** Creates the library root (a first write plants it) and returns its real path. */
export function ensureLibraryRoot(
  root: string,
  noun: string,
  name: string,
): { ok: true; real: string } | { ok: false; error: string } {
  try {
    mkdirSync(root, { recursive: true });
    return { ok: true, real: realpathSync(root) };
  } catch (error) {
    if (isContainmentFailure(error)) {
      return { ok: false, error: `${noun} '${name}' could not be written` };
    }
    throw new StorageError(`${noun} '${name}' could not be written`);
  }
}

/** The flat name resolved against the real root, containment-proven. */
export function containedTarget(
  real: string,
  name: string,
  library: string,
): { ok: true; target: string } | { ok: false; error: string } {
  const target = resolve(real, name);
  if (!isWithinRoot(real, target) || target === real) {
    return { ok: false, error: `path escapes the ${library}` };
  }
  return { ok: true, target };
}

/** Writes one file through the contained writer; returns its rollback. */
export function writeContainedFile(
  real: string,
  target: string,
  content: string,
  noun: string,
  name: string,
): { ok: true; rollback: () => void } | { ok: false; error: string } {
  const rollback = captureFile(target);
  try {
    writeTextFileContained(real, target, content);
  } catch (error) {
    if (isContainmentFailure(error)) {
      return { ok: false, error: `${noun} '${name}' could not be written` };
    }
    throw new StorageError(`${noun} '${name}' could not be written`);
  }
  return { ok: true, rollback };
}

/** Deletes one file; returns its rollback. */
export function deleteContainedFile(
  target: string,
  noun: string,
  name: string,
): { ok: true; rollback: () => void } | { ok: false; error: string } {
  const rollback = captureFile(target);
  try {
    rmSync(target);
  } catch (error) {
    if (isContainmentFailure(error)) {
      return { ok: false, error: `${noun} '${name}' could not be deleted` };
    }
    throw new StorageError(`${noun} '${name}' could not be deleted`);
  }
  return { ok: true, rollback };
}