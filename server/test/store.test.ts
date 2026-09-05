// The event store against the real embedded SurrealDB (RocksDB) in a temp
// directory — no mocks for the database (the v1 rule that earned its keep).

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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

  it('refuses a second concurrent boot on the same data dir (t9)', async () => {
    await fresh();

    const second = new EventStore();
    await expect(second.connect(dir)).rejects.toThrow(/another composer server \(pid \d+\)/);
    // The refused boot took no lock of its own.
    await expect(second.connect(dir)).rejects.toThrow(/another composer server/);

    // Closing the first releases the dir (the lock file goes with it; the
    // cross-process reopen is covered by the restart test above).
    await store.close();
    expect(existsSync(join(dir, 'server.lock'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reaps a stale lock left by a crashed boot', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'server.lock'), String(999_999_999)); // dead pid
    const reopened = new EventStore();
    await reopened.connect(dir); // no throw: the stale lock is reaped
    await reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
