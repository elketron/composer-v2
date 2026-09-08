// Infrastructure failure vs validation failure. The repositories prove path
// grammar and containment without touching I/O; anything the filesystem
// raises beyond that planned rejection (a full disk, a vanished drive, a
// permission change) is an infrastructure failure. That distinction must
// ride the wire differently: a validation rejection is the caller's fault
// (`invalidCommand`), whereas a storage failure is not a domain outcome at
// all — it surfaces as a transport error.

/** A genuine filesystem failure, not a path/containment validation. */
export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

/**
 * A containment rejection (a planted symlink the write must refuse), which
 * is a *security* verdict and stays a normal validation result — not a
 * storage failure. `writeTextFileContained` signals a symlinked parent with
 * `Error('path escapes its root')` and a symlinked final component with
 * `ELOOP` from the `O_NOFOLLOW` open.
 */
export function isContainmentFailure(error: unknown): boolean {
  if (error instanceof Error && error.message === 'path escapes its root') return true;
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ELOOP';
}