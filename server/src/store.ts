// The event store: embedded SurrealDB (RocksDB via @surrealdb/node), one
// database file, one table per concern. The `event_log` is the log of
// truth — composer envelopes persisted as rows keyed by project, in
// emission order (`seq`). Ephemeral events (live-only) skip replay.
//
// Single-writer (t9): a PID lockfile guards the data dir — a second boot
// against a live server's dir is refused with a clear error instead of two
// processes appending colliding seqs to one log.

import { Surreal } from 'surrealdb';
import { createNodeEngines } from '@surrealdb/node';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
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

/** Global (not per-project) app settings. */
export interface ComposerSettings {
  /** The model every agent loads when no per-agent override exists. */
  model?: string;
  /** Per-agent model overrides, keyed by the bare agent kind (planner, coder, …). */
  models?: Record<string, string>;
}

/** A settings update: a value sets the field, null clears it, absent leaves it.
 * `models` (when present) replaces the whole per-agent map. */
export interface SettingsPatch {
  model?: string | null;
  models?: Record<string, string | null>;
}

/** The model an agent kind loads: its override, else the global default. */
export function resolveModel(settings: ComposerSettings, agentKind: string): string | undefined {
  return settings.models?.[agentKind] ?? settings.model;
}

export class EventStore {
  private db!: Surreal;
  private seq = 0;
  private settings: ComposerSettings = {};
  private lockPath: string | null = null;

  async connect(dir: string): Promise<void> {
    mkdirSync(dir, { recursive: true });
    this.acquireDirLock(dir);
    this.db = new Surreal({ engines: { ...createNodeEngines() } });
    await this.db.connect(`rocksdb://${dir}/composer.db`);
    await this.db.use({ namespace: 'composer', database: 'main' });
    await this.db.query(`
      DEFINE TABLE IF NOT EXISTS event_log SCHEMALESS;
      DEFINE INDEX IF NOT EXISTS event_log_project_seq ON event_log FIELDS projectId, seq;
      DEFINE TABLE IF NOT EXISTS settings SCHEMALESS;
    `);
    const [rows] = await this.db.query<[{ seq?: number }[]]>(
      'SELECT seq FROM event_log ORDER BY seq DESC LIMIT 1',
    );
    this.seq = rows?.[0]?.seq ?? 0;
    await this.loadSettings();
  }

  private async loadSettings(): Promise<void> {
    const [rows] = await this.db.query<{ model?: string | null; models?: Record<string, string> | null }[][]>(
      'SELECT model, models FROM settings:global;',
    );
    const row = rows?.[0];
    this.settings = {};
    if (typeof row?.model === 'string' && row.model !== '') this.settings.model = row.model;
    if (row?.models !== null && typeof row?.models === 'object') {
      const models: Record<string, string> = {};
      for (const [kind, model] of Object.entries(row.models)) {
        if (typeof model === 'string' && model !== '') models[kind] = model;
      }
      if (Object.keys(models).length > 0) this.settings.models = models;
    }
  }

  /**
   * The data dir admits one writer: a live PID in `server.lock` refuses the
   * boot with a plain error; a stale lock (dead PID — a crash, or the test
   * child that never ran close()) is removed and boot proceeds.
   */
  private acquireDirLock(dir: string): void {
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
    this.lockPath = lockPath;
  }

  private releaseDirLock(): void {
    if (this.lockPath === null) return;
    try {
      unlinkSync(this.lockPath);
    } catch {
      // Already gone (a concurrent boot reaped it as stale).
    }
    this.lockPath = null;
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

  // ---- Global settings (config, not domain history — outside the log) ----

  /** Global app settings, cached hot (the runner/planner read per spawn). */
  async getSettings(): Promise<ComposerSettings> {
    return {
      ...(this.settings.model !== undefined ? { model: this.settings.model } : {}),
      ...(this.settings.models !== undefined ? { models: { ...this.settings.models } } : {}),
    };
  }

  /** Merges a validated patch and persists it (null clears a field;
   * a `models` patch replaces the whole per-agent map). */
  async putSettings(patch: SettingsPatch): Promise<ComposerSettings> {
    const next: ComposerSettings = {
      ...(this.settings.model !== undefined ? { model: this.settings.model } : {}),
      ...(this.settings.models !== undefined ? { models: { ...this.settings.models } } : {}),
    };
    if (patch.model !== undefined) {
      if (patch.model === null || patch.model === '') delete next.model;
      else next.model = patch.model;
    }
    if (patch.models !== undefined) {
      const models: Record<string, string> = {};
      for (const [kind, model] of Object.entries(patch.models)) {
        const key = kind.trim();
        const value = typeof model === 'string' ? model.trim() : '';
        if (key !== '' && value !== '') models[key] = value;
      }
      if (Object.keys(models).length > 0) next.models = models;
      else delete next.models;
    }
    await this.db.query('UPSERT settings:global SET model = $model, models = $models;', {
      model: next.model ?? null,
      models: next.models ?? null,
    });
    this.settings = next;
    return this.getSettings();
  }

  async close(): Promise<void> {
    // The embedded engine holds the RocksDB lock until process exit; the
    // client close is best-effort (tests reconnect via child processes).
    if (this.db !== undefined) {
      await this.db.close();
    }
    this.releaseDirLock();
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
