import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The data dir admits one writer: a live PID in `server.lock` refuses the
 * boot; a stale lock left by a dead process is removed.
 */
export function acquireDirLock(dir: string): string {
  const lockPath = join(dir, 'server.lock');
  if (existsSync(lockPath)) {
    const raw = readFileSync(lockPath, 'utf8').trim();
    const pid = Number(raw);
    if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) {
      throw new Error(
        `another composer server (pid ${pid}) is already using ${dir} — ` +
          `stop it first (or point COMPOSER_DATA_DIR somewhere else)`,
      );
    }
    unlinkSync(lockPath);
  }
  const fd = openSync(lockPath, 'w');
  writeSync(fd, String(process.pid));
  closeSync(fd);
  return lockPath;
}

export function releaseDirLock(lockPath: string | null): void {
  if (lockPath === null) return;
  try {
    unlinkSync(lockPath);
  } catch {
    // Already gone (a concurrent boot reaped it as stale).
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
