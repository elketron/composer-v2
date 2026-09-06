// The global assistant domain (Phase 6): thread commands, the global
// event-log replay, the snapshot round-trip, stranded-thread recovery, and
// the scripted-engine turn e2e.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Bus } from '../src/bus.js';
import { Processor } from '../src/processor.js';
import { apply, newState, type State } from '../src/fold.js';
import { snapshotEvents } from '../src/snapshot.js';
import { AssistantOrchestrator, resumeStrandedThreads } from '../src/assistant.js';
import { FakeEngine } from '../src/engine/fake.js';
import type { EventFrame } from '../src/wire/envelope.js';

let dir: string;
let store: InstanceType<typeof import('../src/store.js').EventStore>;
let bus: Bus;
let processor: Processor;
let projectsCreated = 0;
const recorded: EventFrame[] = [];

beforeEach(async () => {
  recorded.length = 0;
  projectsCreated = 0;
  dir = mkdtempSync(join(tmpdir(), 'composer-assistant-'));
  const { EventStore } = await import('../src/store.js');
  store = new EventStore();
  await store.connect(dir);
  bus = new Bus(store);
  processor = new Processor(bus);
  bus.subscribe((frame) => recorded.push(frame));
});

afterEach(async () => {
  // A test that restarted the store already closed it (the reopen lives on
  // a different EventStore instance) — close is best-effort here.
  try {
    await store.close();
  } catch {
    // Already closed.
  }
  rmSync(dir, { recursive: true, force: true });
});

async function createProject(name = 'alpha'): Promise<string> {
  const result = await processor.execute(undefined, { type: 'requestProjectCreate', name });
  if (!result.ok) throw new Error(result.rejection.message);
  projectsCreated += 1;
  return `P-${projectsCreated}`;
}

async function createThread(name?: string): Promise<string> {
  const result = await processor.execute(undefined, {
    type: 'requestAssistantThreadCreate',
    ...(name !== undefined ? { name } : {}),
  });
  if (!result.ok) throw new Error(result.rejection.message);
  const thread = (recorded.at(-1)?.body as { thread: { id: string } }).thread;
  return thread.id;
}

function threadOf(threadId: string) {
  const thread = bus.state.assistantThreads.get(threadId);
  if (!thread) throw new Error(`thread ${threadId} not in state`);
  return thread;
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the condition never held');
}

// ---- Thread commands ----

describe('assistant thread commands', () => {
  it('threads_allocate_TH_ids_and_default_their_name', async () => {
    const first = await createThread();
    const second = await createThread();
    expect(first).toBe('TH-1');
    expect(second).toBe('TH-2');
    expect(threadOf(first)).toMatchObject({ name: 'Thread 1', status: 'idle', projectIds: [] });
    expect(threadOf(second).name).toBe('Thread 2');

    const named = await createThread('portfolio');
    expect(threadOf(named).name).toBe('portfolio');
  });

  it('thread_create_rejects_nothing_but_blanks_the_name', async () => {
    const id = await createThread('   ');
    expect(threadOf(id).name).toBe('Thread 1');
  });

  it('archive_and_restore_round_trip_and_are_idempotent', async () => {
    const id = await createThread();
    const archived = await processor.execute(undefined, {
      type: 'requestAssistantThreadArchive',
      threadId: id,
    });
    expect(archived.ok).toBe(true);
    expect(threadOf(id).archivedAt).toBeTruthy();
    // Archiving again is a no-op.
    await processor.execute(undefined, { type: 'requestAssistantThreadArchive', threadId: id });
    expect(recorded.filter((frame) => frame.eventType === 'assistantThreadArchived')).toHaveLength(1);

    const restored = await processor.execute(undefined, {
      type: 'requestAssistantThreadRestore',
      threadId: id,
    });
    expect(restored.ok).toBe(true);
    expect(threadOf(id).archivedAt).toBeUndefined();
    await processor.execute(undefined, { type: 'requestAssistantThreadRestore', threadId: id });
    expect(recorded.filter((frame) => frame.eventType === 'assistantThreadRestored')).toHaveLength(1);
  });

  it('unknown_threads_reject_with_unknownThread', async () => {
    const archive = await processor.execute(undefined, {
      type: 'requestAssistantThreadArchive',
      threadId: 'TH-9',
    });
    const message = await processor.execute(undefined, {
      type: 'requestAssistantMessage',
      threadId: 'TH-9',
      text: 'hello',
    });
    expect(archive).toEqual({
      ok: false,
      rejection: { code: 'unknownThread', message: 'Unknown thread TH-9' },
    });
    expect(message.ok).toBe(false);
    expect(message.ok ? null : message.rejection.code).toBe('unknownThread');
  });

  it('scope_replaces_wholesale_and_validates_projects', async () => {
    const alpha = await createProject('alpha');
    const beta = await createProject('beta');
    const id = await createThread();

    const scoped = await processor.execute(undefined, {
      type: 'requestAssistantThreadScope',
      threadId: id,
      projectIds: [alpha, beta, alpha, ''],
    });
    expect(scoped.ok).toBe(true);
    expect(threadOf(id).projectIds).toEqual([alpha, beta]);

    const unknown = await processor.execute(undefined, {
      type: 'requestAssistantThreadScope',
      threadId: id,
      projectIds: ['P-99'],
    });
    expect(unknown.ok ? null : unknown.rejection.code).toBe('unknownProject');
  });

  it('scope_rejects_archived_projects_and_archived_threads', async () => {
    const alpha = await createProject('alpha');
    const id = await createThread();

    await processor.execute(alpha, { type: 'requestProjectArchive', projectId: alpha });
    const archivedProject = await processor.execute(undefined, {
      type: 'requestAssistantThreadScope',
      threadId: id,
      projectIds: [alpha],
    });
    expect(archivedProject.ok).toBe(false);
    expect(archivedProject.ok ? null : archivedProject.rejection.message).toContain('archived');

    await processor.execute(undefined, { type: 'requestAssistantThreadArchive', threadId: id });
    const archivedThread = await processor.execute(undefined, {
      type: 'requestAssistantThreadScope',
      threadId: id,
      projectIds: [],
    });
    expect(archivedThread.ok).toBe(false);
    expect(archivedThread.ok ? null : archivedThread.rejection.message).toContain('archived');
  });

  it('messages_get_sequential_indexes_and_reopen_the_thread', async () => {
    const id = await createThread();
    const first = await processor.execute(undefined, {
      type: 'requestAssistantMessage',
      threadId: id,
      text: 'what needs me?',
    });
    expect(first.ok).toBe(true);
    expect(threadOf(id).messages).toEqual([
      expect.objectContaining({ index: 1, role: 'user', text: 'what needs me?' }),
    ]);
    // The user message opened the turn.
    expect(threadOf(id).status).toBe('running');

    await bus.publish(undefined, 'assistantMessageComplete', {
      threadId: id,
      message: { index: 2, role: 'agent', text: 'two projects need you', at: new Date().toISOString() },
    });
    expect(threadOf(id).status).toBe('idle');
    expect(threadOf(id).messages).toHaveLength(2);
  });

  it('empty_messages_and_archived_threads_reject', async () => {
    const id = await createThread();
    const empty = await processor.execute(undefined, {
      type: 'requestAssistantMessage',
      threadId: id,
      text: '   ',
    });
    expect(empty.ok).toBe(false);
    expect(empty.ok ? null : empty.rejection.message).toContain('text is required');

    await processor.execute(undefined, { type: 'requestAssistantThreadArchive', threadId: id });
    const archived = await processor.execute(undefined, {
      type: 'requestAssistantMessage',
      threadId: id,
      text: 'hello',
    });
    expect(archived.ok).toBe(false);
    expect(archived.ok ? null : archived.rejection.message).toContain('archived');
  });

  it('replayGlobal_reads_the_global_slice_and_skips_ephemeral_deltas', async () => {
    const id = await createThread();
    await processor.execute(undefined, {
      type: 'requestAssistantMessage',
      threadId: id,
      text: 'hello',
    });
    // An ephemeral delta persists for the live stream but skips replay.
    await bus.publish(undefined, 'assistantMessageDelta', {
      threadId: id,
      messageIndex: 2,
      delta: 'streaming',
    });

    const global = await store.replayGlobal();
    expect(global.map((envelope) => envelope.name)).toEqual([
      'assistantThreadCreated',
      'assistantUserMessage',
    ]);
    // Global rows stay out of the project registry.
    expect(await store.projectIds()).toEqual([]);
  });

  it('a restart rehydrates the global slice into the fold', { timeout: 30_000 }, async () => {
    // The embedded engine holds the RocksDB lock until process exit, so
    // the restart is exercised across real process boundaries: boot 1 (the
    // child) writes global events and exits; boot 2 (this process) opens
    // the directory for the first time.
    const restartDir = mkdtempSync(join(tmpdir(), 'composer-assistant-restart-'));
    try {
      const { execFileSync } = await import('node:child_process');
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
          import { EventStore } from ${JSON.stringify(join(import.meta.dirname, '..', 'src', 'store.ts'))};
          const store = new EventStore();
          await store.connect(${JSON.stringify(restartDir)});
          await store.append(
            { id: 'g1', occurredAt: '2026-09-06T12:00:00.000001Z', name: 'assistantThreadCreated', body: { thread: { id: 'TH-1', name: 'Thread 1', createdAt: '2026-09-06T12:00:00.000001Z', status: 'idle', projectIds: [], messages: [] } } },
            false,
          );
          await store.append(
            { id: 'g2', occurredAt: '2026-09-06T12:00:00.000002Z', name: 'assistantMessageDelta', body: { threadId: 'TH-1', messageIndex: 1, delta: 'lost' } },
            true,
          );
          await store.append(
            { id: 'g3', occurredAt: '2026-09-06T12:00:00.000003Z', name: 'assistantUserMessage', body: { threadId: 'TH-1', message: { index: 1, role: 'user', text: 'hello', at: '2026-09-06T12:00:00.000003Z' } } },
            false,
          );
          await store.close();
          process.exit(0);
        `,
        ],
        { stdio: 'inherit' },
      );

      const { EventStore } = await import('../src/store.js');
      const reopened = new EventStore();
      await reopened.connect(restartDir);
      const bus2 = new Bus(reopened);
      const count = await bus2.rehydrate();
      expect(count).toBe(2, 'the ephemeral delta skips replay');
      const thread = bus2.state.assistantThreads.get('TH-1');
      expect(thread?.status).toBe('running');
      expect(thread?.messages).toEqual([
        expect.objectContaining({ index: 1, role: 'user', text: 'hello' }),
      ]);
      await reopened.close();
    } finally {
      rmSync(restartDir, { recursive: true, force: true });
    }
  });

  it('the_assistant_snapshot_replays_into_equal_state', async () => {
    const alpha = await createProject('alpha');
    const id = await createThread('portfolio');
    await processor.execute(undefined, {
      type: 'requestAssistantThreadScope',
      threadId: id,
      projectIds: [alpha],
    });
    await processor.execute(undefined, {
      type: 'requestAssistantMessage',
      threadId: id,
      text: 'what needs me?',
    });
    await bus.publish(undefined, 'assistantMessageComplete', {
      threadId: id,
      message: { index: 2, role: 'agent', text: 'reply', at: new Date().toISOString() },
    });

    const snapshot = snapshotEvents(bus.state);
    const replayed: State = newState();
    for (const frame of snapshot) {
      apply(replayed, {
        id: frame.id,
        ...(frame.projectId !== undefined ? { projectId: frame.projectId } : {}),
        occurredAt: frame.occurredAt,
        name: frame.eventType,
        body: frame.body,
      });
    }
    expect(replayed.assistantThreads).toEqual(bus.state.assistantThreads);
    // Global frames carry no projectId and precede the projects.
    expect(snapshot[0]?.projectId).toBeUndefined();
    expect(snapshot[0]?.eventType).toBe('assistantThreadCreated');
  });
});

// ---- Stranded threads (t10's global analog) ----

describe('resumeStrandedThreads', () => {
  it('publishes a failure message for a transcript that ends with a user message', async () => {
    const id = await createThread();
    await processor.execute(undefined, {
      type: 'requestAssistantMessage',
      threadId: id,
      text: 'what needs me?',
    });

    const resumed = await resumeStrandedThreads(bus);
    expect(resumed).toBe(1);

    expect(threadOf(id).messages.at(-1)).toMatchObject({
      role: 'agent',
      text: 'the server restarted before this turn could run — send your message again',
    });
    expect(recorded.at(-1)?.eventType).toBe('assistantMessageComplete');
    expect(recorded.at(-1)?.projectId).toBeUndefined();
  });

  it('leaves threads that do not end with a user message alone', async () => {
    const id = await createThread();
    await bus.publish(undefined, 'assistantMessageComplete', {
      threadId: id,
      message: { index: 1, role: 'agent', text: 'earlier reply', at: new Date().toISOString() },
    });
    const archived = await createThread('old');
    await processor.execute(undefined, {
      type: 'requestAssistantThreadArchive',
      threadId: archived,
    });

    const resumed = await resumeStrandedThreads(bus);
    expect(resumed).toBe(0);
    expect(threadOf(id).messages).toHaveLength(1);
  });
});

// ---- The scripted-engine e2e ----

describe('the assistant turn', () => {
  let engine: FakeEngine;
  let orchestrator: AssistantOrchestrator;

  beforeEach(async () => {
    engine = new FakeEngine(processor);
    orchestrator = new AssistantOrchestrator(bus, engine, { serverUrl: 'http://127.0.0.1:0' });
    orchestrator.start();
  });

  it('a_message_runs_a_turn_that_streams_and_completes', async () => {
    const id = await createThread();
    engine.enqueue(async ({ emit }) => {
      emit({ kind: 'messageDelta', messageId: 'm1', delta: 'looking ' });
      emit({ kind: 'messageDelta', messageId: 'm1', delta: 'around' });
      return 'Two projects have waiting approvals.';
    });

    const sent = await processor.execute(undefined, {
      type: 'requestAssistantMessage',
      threadId: id,
      text: 'what needs me?',
    });
    expect(sent.ok).toBe(true);

    await waitUntil(() => threadOf(id).status === 'idle');
    const kinds = recorded.map((frame) => frame.eventType);
    expect(kinds).toContain('assistantMessageDelta');
    expect(kinds).toContain('assistantMessageComplete');
    // Deltas are ephemeral; the completion is durable.
    expect(recorded.find((frame) => frame.eventType === 'assistantMessageDelta')?.projectId).toBeUndefined();
    expect(threadOf(id).messages.map((message) => message.role)).toEqual(['user', 'agent']);
    expect(threadOf(id).messages.at(-1)?.text).toBe('Two projects have waiting approvals.');
  });

  it('the_thread_scope_rides_the_prompt_and_the_engine_session_is_kept', async () => {
    const alpha = await createProject('alpha');
    const id = await createThread();
    await processor.execute(undefined, {
      type: 'requestAssistantThreadScope',
      threadId: id,
      projectIds: [alpha],
    });

    engine.enqueue(async () => 'first reply');
    engine.enqueue(async () => 'second reply');

    await processor.execute(undefined, {
      type: 'requestAssistantMessage',
      threadId: id,
      text: 'first question',
    });
    await waitUntil(() => engine.toolCalls.length === 1);
    await processor.execute(undefined, {
      type: 'requestAssistantMessage',
      threadId: id,
      text: 'follow-up',
    });
    await waitUntil(() => threadOf(id).messages.filter((m) => m.role === 'agent').length === 2);

    const [first, second] = engine.toolCalls;
    expect(first?.prompt).toContain(`Selected projects: ${alpha}`);
    // The durable transcript tail rides the prompt (context survives a
    // restart's fresh engine session).
    expect(first?.prompt).toContain('user: first question');
    expect(second?.prompt).toContain('assistant: first reply');
    expect(first?.mcpTools).toBe('assistant');
    expect(first?.agentName).toBe('composer-assistant');
    expect(second?.engineSessionId).toBe(`fake-${id}`);
  });

  it('the_assistant_workspace_ships_the_agent_definition_and_rocks_the_cwd', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'composer-assistant-ws-'));
    try {
      orchestrator.stop(); // the default orchestrator steps aside
      engine.enqueue(async () => 'reply');
      const withWorkspace = new AssistantOrchestrator(bus, engine, {
        serverUrl: 'http://127.0.0.1:0',
        workspaceDir: workspace,
      });
      withWorkspace.start();
      const id = await createThread();
      await processor.execute(undefined, {
        type: 'requestAssistantMessage',
        threadId: id,
        text: 'hello',
      });
      await waitUntil(() => engine.toolCalls.length >= 1);
      const spec = engine.toolCalls[0];
      expect(spec?.projectDirectory).toBe(workspace);
      const { existsSync } = await import('node:fs');
      expect(existsSync(join(workspace, '.opencode', 'agent', 'composer-assistant.md'))).toBe(true);
      withWorkspace.stop();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('a_failed_turn_publishes_the_failure_as_an_agent_message', async () => {
    const id = await createThread();
    engine.enqueue(async () => ({ error: 'the runtime exploded' }));

    await processor.execute(undefined, {
      type: 'requestAssistantMessage',
      threadId: id,
      text: 'hello',
    });
    await waitUntil(() => threadOf(id).messages.some((message) => message.text.includes('failed')));
    expect(threadOf(id).messages.at(-1)).toMatchObject({
      role: 'agent',
      text: 'The assistant turn failed: the runtime exploded',
    });
  });

  it('a_message_sent_mid_turn_is_served_by_the_next_run', async () => {
    const id = await createThread();
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    engine.enqueue(async ({ emit }) => {
      emit({ kind: 'messageDelta', messageId: 'a', delta: 'working' });
      await firstGate;
      return 'first reply';
    });
    engine.enqueue(async () => 'second reply');

    await processor.execute(undefined, {
      type: 'requestAssistantMessage',
      threadId: id,
      text: 'first',
    });
    // The second user message lands while the first turn is still parked.
    await processor.execute(undefined, {
      type: 'requestAssistantMessage',
      threadId: id,
      text: 'second',
    });
    releaseFirst?.();

    await waitUntil(
      () => threadOf(id).messages.filter((message) => message.role === 'agent').length === 2,
    );
    // The transcript sorts by index: both user messages precede both replies.
    expect(threadOf(id).messages.map((message) => message.text)).toEqual([
      'first',
      'second',
      'first reply',
      'second reply',
    ]);
  });

  it('an_archived_thread_runs_no_turn', async () => {
    const id = await createThread();
    await processor.execute(undefined, { type: 'requestAssistantThreadArchive', threadId: id });

    // Archived threads reject messages outright, so no turn can start.
    const sent = await processor.execute(undefined, {
      type: 'requestAssistantMessage',
      threadId: id,
      text: 'hello',
    });
    expect(sent.ok).toBe(false);
    expect(engine.toolCalls).toHaveLength(0);
  });
});
