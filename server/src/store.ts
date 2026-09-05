// The event store: embedded SurrealDB (RocksDB via @surrealdb/node), one
// database file, one table per concern. The `event_log` is the log of
// truth — composer envelopes persisted as rows keyed by project, in
// emission order (`seq`). Ephemeral events (live-only) skip replay.

import { Surreal } from 'surrealdb';
import { createNodeEngines } from '@surrealdb/node';
import type { EventEnvelope } from './wire/envelope.js';
import type { EventName } from './wire/events.js';

interface EventRow {
  id: string;
  projectId: string | null;
  seq: number;
  name: string;
  payload: {
    id: string;
    projectId?: string;
    occurredAt: string;
    body: unknown;
  };
  ephemeral: boolean;
}

export class EventStore {
  private db!: Surreal;
  private seq = 0;

  async connect(dir: string): Promise<void> {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    this.db = new Surreal({ engines: { ...createNodeEngines() } });
    await this.db.connect(`rocksdb://${dir}/composer.db`);
    await this.db.use({ namespace: 'composer', database: 'main' });
    await this.db.query(`
      DEFINE TABLE IF NOT EXISTS event_log SCHEMALESS;
      DEFINE INDEX IF NOT EXISTS event_log_project_seq ON event_log FIELDS projectId, seq;
    `);
    const [rows] = await this.db.query<[{ seq?: number }[]]>(
      'SELECT seq FROM event_log ORDER BY seq DESC LIMIT 1',
    );
    this.seq = rows?.[0]?.seq ?? 0;
  }

  /** Persists one event and returns its assigned sequence. */
  async append(envelope: EventEnvelope, ephemeral: boolean): Promise<number> {
    const seq = ++this.seq;
    await this.db.query('CREATE event_log SET projectId = $projectId, seq = $seq, name = $name, payload = $payload, ephemeral = $ephemeral;', {
      projectId: envelope.projectId ?? null,
      seq,
      name: envelope.name,
      payload: {
        id: envelope.id,
        ...(envelope.projectId !== undefined ? { projectId: envelope.projectId } : {}),
        occurredAt: envelope.occurredAt,
        body: envelope.body,
      },
      ephemeral,
    });
    return seq;
  }

  /** Replays a project's non-ephemeral events, in emission order. */
  async replay(projectId: string): Promise<EventEnvelope[]> {
    const [rows] = await this.db.query<EventRow[][]>(
      'SELECT * FROM event_log WHERE projectId = $projectId AND ephemeral != true ORDER BY seq;',
      { projectId },
    );
    return (rows ?? []).map((row) => ({
      id: row.payload.id,
      projectId: row.payload.projectId,
      occurredAt: row.payload.occurredAt,
      name: row.name as EventName,
      body: row.payload.body,
    }));
  }

  /**
   * The project ids that have events, derived from the log itself — the
   * log of truth needs no registry beside it.
   */
  async projectIds(): Promise<string[]> {
    const [rows] = await this.db.query<{ projectId: string }[][]>(
      'SELECT projectId FROM event_log;',
    );
    const ids = new Set<string>();
    for (const row of rows ?? []) {
      if (typeof row.projectId === 'string' && row.projectId !== '') ids.add(row.projectId);
    }
    return [...ids];
  }

  async close(): Promise<void> {
    // The embedded engine holds the RocksDB lock until process exit; the
    // client close is best-effort (tests reconnect via child processes).
    if (this.db !== undefined) {
      await this.db.close();
    }
  }
}
