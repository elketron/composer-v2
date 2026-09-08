// The embedded SurrealDB lifecycle (SRV-009): the database connection, the
// process lock, and the event sequence counter — the shared object the
// event and settings repositories each sit over. Persistence concerns live
// in the repositories; this class owns only the database lifecycle.

import { createNodeEngines } from '@surrealdb/node';
import { mkdirSync } from 'node:fs';
import { Surreal } from 'surrealdb';

const moduleExtension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
const { initializeEventLog } = await import(`./event-log.${moduleExtension}`) as typeof import('./event-log.js');
const { acquireDirLock, releaseDirLock } = await import(`./pid-lock.${moduleExtension}`) as typeof import('./pid-lock.js');

export class ComposerDatabase {
  private db!: Surreal;
  private seq = 0;
  private lockPath: string | null = null;

  async connect(dir: string): Promise<void> {
    mkdirSync(dir, { recursive: true });
    this.lockPath = acquireDirLock(dir);
    this.db = new Surreal({ engines: { ...createNodeEngines() } });
    await this.db.connect(`rocksdb://${dir}/composer.db`);
    await this.db.use({ namespace: 'composer', database: 'main' });
    this.seq = await initializeEventLog(this.db);
  }

  /** The underlying Surreal client (repositories query through it). */
  get client(): Surreal {
    return this.db;
  }

  /** One past the last persisted event's sequence. */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  async close(): Promise<void> {
    // The embedded engine holds the RocksDB lock until process exit; the
    // client close is best-effort (tests reconnect via child processes).
    if (this.db !== undefined) {
      await this.db.close();
    }
    releaseDirLock(this.lockPath);
    this.lockPath = null;
  }
}