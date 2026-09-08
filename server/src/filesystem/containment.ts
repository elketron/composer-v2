import { closeSync, constants, openSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';

export function isWithinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * Writes through a verified real parent and refuses a symlink in the final
 * path component. Node has no portable openat API, so callers must still
 * avoid sharing writable repository roots with an active attacker.
 */
export function writeTextFileContained(root: string, target: string, content: string): string {
  const rootReal = realpathSync(root);
  const parentReal = realpathSync(dirname(target));
  if (!isWithinRoot(rootReal, parentReal)) throw new Error('path escapes its root');

  const resolvedTarget = join(parentReal, basename(target));
  const handle = openSync(
    resolvedTarget,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o666,
  );
  try {
    writeFileSync(handle, content, 'utf8');
  } finally {
    closeSync(handle);
  }
  return resolvedTarget;
}
