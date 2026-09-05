// The boot contract, end to end: the real server (embedded RocksDB in a
// temp dir) answers /health, POST /action validates + emits, and GET
// /events delivers the snapshot then live frames — the same flow the
// desktop rides.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boot } from '../src/index.js';

let dir: string;
let server: Awaited<ReturnType<typeof boot>>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'composer-http-'));
  server = await boot({ addr: '127.0.0.1:0', dataDir: dir });
});

afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function action(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${server.url}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function collectFrames(url: string, minimum: number): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${url}/events`);
  const frames: Record<string, unknown>[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (frames.length < minimum) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)));
    }
  }
  reader.cancel();
  return frames;
}


describe('the boot contract', () => {
  it('health_returns_serving', async () => {
    const response = await fetch(`${server.url}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'SERVING' });
  });

  it('malformed_actions_are_400', async () => {
    const result = await action({ type: 'conjure', on: 'card' });
    expect(result.status).toBe(400);
  });

  it('a_created_project_replays_in_the_snapshot_and_streams_live', async () => {
    const created = await action({
      type: 'create',
      on: 'project',
      body: { name: 'alpha' },
    });
    expect(created.status).toBe(200);
    expect(created.json).toEqual({ ok: true });

    // The snapshot carries the project; a live event arrives afterwards.
    const frames = await Promise.race([
      collectFrames(server.url, 2),
      (async () => {
        // A live event 300ms in: the subscriber is active before this.
        await new Promise((resolve) => setTimeout(resolve, 300));
        await action({ type: 'update', on: 'project', body: { id: 'P-1', active: true } });
        return collectFrames(server.url, 2);
      })(),
    ]);

    const kinds = frames.map((frame) => frame['eventType']);
    expect(kinds).toContain('projectCreated');
    expect(kinds).toContain('projectActivated');
    expect(
      (frames.find((frame) => frame['eventType'] === 'projectCreated')?.body as { project: { name: string } })
        .project.name,
    ).toBe('alpha');
  }, 15_000);

  it('a_restart_replays_the_log_without_reseeding', { timeout: 60_000 }, async () => {
    // The embedded engine holds the RocksDB lock until process exit, so
    // the restart spans a real process boundary: boot 1 is a child process
    // that writes the log and exits; boot 2 is this process's first open
    // of the directory (the desktop's spawn flow).
    const restartDir = mkdtempSync(join(tmpdir(), 'composer-restart-'));
    const { execFileSync } = await import('node:child_process');
    execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', `
        import { EventStore } from ${JSON.stringify(join(import.meta.dirname, '..', 'src', 'store.ts'))};
        const store = new EventStore();
        await store.connect(${JSON.stringify(restartDir)});
        await store.append(
          { id: 'e1', projectId: 'P-1', occurredAt: '2026-09-04T12:00:00.000002Z', name: 'projectCreated', body: { project: { id: 'P-1', name: 'alpha', createdAt: '2026-09-04T12:00:00.000001Z' } } },
          false,
        );
        await store.close();
        process.exit(0);
      `],
      { stdio: 'inherit' },
    );

    const server2 = await boot({ addr: '127.0.0.1:0', dataDir: restartDir });
    try {
      const frames = await collectFrames(server2.url, 1);
      expect(frames.length).toBe(1, 'the restart replays the log; no re-seed');
      expect(frames[0]?.['eventType']).toBe('projectCreated');
      expect((frames[0]?.body as { project: { name: string } }).project.name).toBe('alpha');
    } finally {
      await server2.close();
      rmSync(restartDir, { recursive: true, force: true });
    }
  });
})