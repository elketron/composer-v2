// The boot contract, end to end: the real server (embedded RocksDB in a
// temp dir) answers /health, POST /action validates + emits, and GET
// /events delivers the snapshot then live frames — the same flow the
// desktop rides.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boot } from '../src/index.js';
import { subStateFor } from '../src/wire/models.js';

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

  it('the_planning_actions_and_the_mcp_route_drive_a_session', async () => {
    await action({ type: 'create', on: 'project', body: { name: 'alpha' } });

    // The desktop's paths: create:planningSession then create:chatMessage.
    const created = await action({ type: 'create', on: 'planningSession', projectId: 'P-1', body: {} });
    expect(created).toEqual({ status: 200, json: { ok: true } });
    const message = await action({
      type: 'create',
      on: 'chatMessage',
      projectId: 'P-1',
      body: { sessionId: 'S-1', text: 'plan the board' },
    });
    expect(message).toEqual({ status: 200, json: { ok: true } });

    // The MCP tools' route: a whitelisted planning command.
    const doc = await fetch(`${server.url}/mcp/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'P-1',
        command: { type: 'requestPlanDocumentUpdate', sessionId: 'S-1', document: '<plan>v1</plan>' },
      }),
    });
    expect(doc.status).toBe(200);
    expect((await doc.json()) as unknown).toEqual({ ok: true });

    // Out-of-scope commands are malformed here even when valid on /action.
    const card = await fetch(`${server.url}/mcp/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'P-1',
        command: { type: 'requestCardCreate', card: {} },
      }),
    });
    expect(card.status).toBe(400);

    // The session folded the message and the document: the snapshot's
    // planningSessionCreated carries the current record, its messages
    // replay after it, and the seeded pipeline rides last.
    const frames = await collectFrames(server.url, 4);
    const kinds = frames.map((frame) => frame['eventType']);
    expect(kinds).toEqual(['projectCreated', 'planningSessionCreated', 'userMessageReceived', 'pipelineSaved']);
    const session = (frames[1]?.body as { session: { planDocument: string; messages: { text: string }[] } }).session;
    expect(session.planDocument).toBe('<plan>v1</plan>');
    expect(session.messages).toEqual([expect.objectContaining({ role: 'user', text: 'plan the board' })]);
  }, 15_000);

  it('card_actions_drive_the_board_end_to_end', async () => {
    // Subscribe before anything happens: the empty snapshot is 0 frames,
    // then every action's live event arrives in order.
    const framesPromise = collectFrames(server.url, 11);
    await new Promise((resolve) => setTimeout(resolve, 300));

    await action({ type: 'create', on: 'project', body: { name: 'alpha' } });

    // create:card (single) — the server assigns id and sub-state.
    const created = await action({
      type: 'create',
      on: 'card',
      projectId: 'P-1',
      body: { title: 'Board drag & drop', type: 'coding' },
    });
    expect(created).toEqual({ status: 200, json: { ok: true } });

    // create:card (bulk) — blockedBy references the existing card.
    const bulk = await action({
      type: 'create',
      on: 'card',
      projectId: 'P-1',
      body: { cards: [{ title: 'dependent', type: 'coding', blockedBy: ['T-1'] }] },
    });
    expect(bulk).toEqual({ status: 200, json: { ok: true } });

    // update:card (stage) — the drag.
    const moved = await action({
      type: 'update',
      on: 'card',
      projectId: 'P-1',
      body: { id: 'T-1', stage: 'validation' },
    });
    expect(moved.json).toEqual({ ok: true });

    // update:card (subState) — the checklist.
    const subState = await action({
      type: 'update',
      on: 'card',
      projectId: 'P-1',
      body: { id: 'T-1', subState: { stage: 'runValidation', status: 'ok' } },
    });
    expect(subState.json).toEqual({ ok: true });

    // update:automation — the lane toggle.
    const automation = await action({
      type: 'update',
      on: 'automation',
      projectId: 'P-1',
      body: { lane: 'validation', on: false },
    });
    expect(automation.json).toEqual({ ok: true });

    // update:card (type) — resets sub-state; validation is not a design lane.
    const typeChange = await action({
      type: 'update',
      on: 'card',
      projectId: 'P-1',
      body: { id: 'T-1', type: 'design' },
    });
    expect(typeChange.json).toEqual({ ok: true });

    // delete:card — archive.
    const archived = await action({
      type: 'delete',
      on: 'card',
      projectId: 'P-1',
      body: { id: 'T-2' },
    });
    expect(archived.json).toEqual({ ok: true });

    // update:card with two mutation fields is malformed, not a rejection.
    const ambiguous = await action({
      type: 'update',
      on: 'card',
      projectId: 'P-1',
      body: { id: 'T-1', stage: 'review', type: 'docs' },
    });
    expect(ambiguous.status).toBe(400);

    const frames = await framesPromise;
    expect(frames.map((frame) => frame['eventType'])).toEqual([
      'projectCreated',
      'projectActivated',
      'pipelineSaved',
      'cardCreated',
      'cardCreated',
      'dependencyStateChanged',
      'cardMoved',
      'subStateUpdated',
      'automationToggled',
      'cardTypeChanged',
      'cardArchived',
    ]);
    const dependent = frames[4]?.body as { card: { id: string; blockedBy: string[]; subState: Record<string, string> } };
    expect(dependent.card).toMatchObject({ id: 'T-2', blockedBy: ['T-1'] });
    expect(dependent.card.subState).toEqual(subStateFor('coding'));
  }, 15_000);

  it('a_created_project_replays_in_the_snapshot_and_streams_live', async () => {
    const created = await action({
      type: 'create',
      on: 'project',
      body: { name: 'alpha' },
    });
    expect(created.status).toBe(200);
    expect(created.json).toEqual({ ok: true });

    // The snapshot carries the project and its seeded pipeline; a live
    // event arrives afterwards.
    const frames = await Promise.race([
      collectFrames(server.url, 3),
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

  it('settings_round_trip_over_http', async () => {
    const put = await fetch(`${server.url}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llamacpp/qwen3.6' }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ model: 'llamacpp/qwen3.6' });

    const get = await fetch(`${server.url}/settings`);
    expect(await get.json()).toEqual({ model: 'llamacpp/qwen3.6' });

    // An explicit null (or empty string) clears the field.
    const clear = await fetch(`${server.url}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: null }),
    });
    expect(await clear.json()).toEqual({});

    // Malformed: a non-string model.
    const bad = await fetch(`${server.url}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 42 }),
    });
    expect(bad.status).toBe(400);
  });
})