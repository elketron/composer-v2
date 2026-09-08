// The directory resolver (SRV-025): resolves a directory-ish string to an
// existing absolute directory, canonical (symlink-resolved) and against an
// explicit base directory rather than the ambient cwd. Injected into the
// processor so the project commands don't reach `process.cwd()`/`statSync`
// directly.

import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export type DirectoryResolver = (value: string | undefined) => string | null;

/** A resolver whose relative paths resolve against `base`. */
export function makeDirectoryResolver(base: string): DirectoryResolver {
  return (value) => {
    if (value === undefined || value.trim() === '') return null;
    const path = isAbsolute(value) ? value : join(base, value);
    try {
      const real = realpathSync(path);
      return statSync(real).isDirectory() ? real : null;
    } catch {
      return null;
    }
  };
}