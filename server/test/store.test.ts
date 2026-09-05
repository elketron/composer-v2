// The event store against the real embedded SurrealDB (RocksDB) in a temp
// directory — no mocks for the database (the v1 rule that earned its keep).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { EventStore } from '../src/store.js';

let dir: string;
let store: EventStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'composer-store-'));
  store = new EventStore();
});

afterAll(async () => {
  // Directories cleaned per store below; vitest teardown closes leftovers.
});

async function fresh(): Promise<EventStore> {
  await store.connect(dir);
  return store;
}

describe('EventStore', () => {
  it('appends and replays in emission order, skipping ephemeral events', async () => {
    await fresh();
    await store.append(
      { id: 'e1', projectId: 'P-1', occurredAt: '2026-09-04T12:00:00.000001Z', name: 'projectCreated', body: { project: { id: 'P-1' } } },
      false,
    );
    await store.append(
      { id: 'e2', projectId: 'P-1', occurredAt: '2026-09-04T12:00:00.000002Z', name: 'agentMessageDelta', body: { delta: 'he' } },
      true,
    );
    await store.append(
      { id: 'e3', projectId: 'P-1', occurredAt: '2026-09-04T12:00:00.000003Z', name: 'cardCreated', body: { card: { id: 'T-1' } } },
      false,
    );

    const replayed = await store.replay('P-1');
    expect(replayed.map((envelope) => envelope.name)).toEqual(['projectCreated', 'cardCreated']);
    expect(replayed[0]?.body).toEqual({ project: { id: 'P-1' } });
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps projects isolated in one log', async () => {
    await fresh();
    await store.append(
      { id: 'e1', projectId: 'P-1', occurredAt: '2026-09-04T12:00:00.000003Z', name: 'projectCreated', body: {} },
      false,
    );
    await store.append(
      { id: 'e2', projectId: 'P-2', occurredAt: '2026-09-04T12:00:00.000004Z', name: 'projectCreated', body: {} },
      false,
    );

    expect((await store.replay('P-1')).length).toBe(1);
    expect((await store.replay('P-2')).length).toBe(1);
    expect((await store.projectIds()).sort()).toEqual(['P-1', 'P-2']);
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a restart continues the same log', { timeout: 30_000 }, async () => {
    // The embedded engine holds the RocksDB lock until process exit, so
    // the restart is exercised the real way: boot 1 is a child process
    // that writes one event and exits; boot 2 reopens the same log here.
    const { execFileSync } = await import('node:child_process');
    execFileSync(
      process.execPath,
      ['--input-type=module', '-e', `
        import { EventStore } from ${JSON.stringify(join(import.meta.dirname, '..', 'src', 'store.ts'))};
        const store = new EventStore();
        await store.connect(${JSON.stringify(dir)});
        await store.append(
          { id: 'e1', projectId: 'P-1', occurredAt: '2026-09-04T12:00:00.000001Z', name: 'projectCreated', body: {} },
          false,
        );
        await store.close();
        process.exit(0);
      `],
      { stdio: 'inherit' },
    );

    const reopened = new EventStore();
    await reopened.connect(dir);
    await reopened.append(
      { id: 'e2', projectId: 'P-1', occurredAt: '2026-09-04T12:00:00.000002Z', name: 'cardCreated', body: {} },
      false,
    );
    const replayed = await reopened.replay('P-1');
    expect(replayed.map((envelope) => envelope.id)).toEqual(['e1', 'e2']);
    await reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
