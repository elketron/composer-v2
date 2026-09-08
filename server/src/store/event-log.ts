import type { Surreal } from 'surrealdb';
import type { EventEnvelope } from '../wire/envelope.js';
import type { EventName } from '../wire/events.js';

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

export async function initializeEventLog(db: Surreal): Promise<number> {
  await db.query(`
    DEFINE TABLE IF NOT EXISTS event_log SCHEMALESS;
    DEFINE INDEX IF NOT EXISTS event_log_project_seq ON event_log FIELDS projectId, seq;
    DEFINE TABLE IF NOT EXISTS settings SCHEMALESS;
  `);
  const [rows] = await db.query<[{ seq?: number }[]]>(
    'SELECT seq FROM event_log ORDER BY seq DESC LIMIT 1',
  );
  return rows?.[0]?.seq ?? 0;
}

export async function persistEvent(
  db: Surreal,
  envelope: EventEnvelope,
  seq: number,
  ephemeral: boolean,
): Promise<void> {
  await db.query('CREATE event_log SET projectId = $projectId, seq = $seq, name = $name, payload = $payload, ephemeral = $ephemeral;', {
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
}

export async function replayProject(db: Surreal, projectId: string): Promise<EventEnvelope[]> {
  const [rows] = await db.query<EventRow[][]>(
    'SELECT * FROM event_log WHERE projectId = $projectId AND ephemeral != true ORDER BY seq;',
    { projectId },
  );
  return (rows ?? []).map(toEnvelope);
}

export async function replayGlobalEvents(db: Surreal): Promise<EventEnvelope[]> {
  const [rows] = await db.query<EventRow[][]>(
    'SELECT * FROM event_log WHERE projectId IS NULL AND ephemeral != true ORDER BY seq;',
  );
  return (rows ?? []).map(toEnvelope);
}

export async function listProjectIds(db: Surreal): Promise<string[]> {
  const [rows] = await db.query<{ projectId: string }[][]>('SELECT projectId FROM event_log;');
  const ids = new Set<string>();
  for (const row of rows ?? []) {
    if (typeof row.projectId === 'string' && row.projectId !== '') ids.add(row.projectId);
  }
  return [...ids];
}

function toEnvelope(row: EventRow): EventEnvelope {
  return {
    id: row.payload.id,
    projectId: row.payload.projectId,
    occurredAt: row.payload.occurredAt,
    name: row.name as EventName,
    body: row.payload.body,
  };
}
