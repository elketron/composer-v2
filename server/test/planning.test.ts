// The planning turn: the domain suite (v1's processor behavioral tests for
// the session/document/tickets commands) plus the scripted-engine e2e —
// user message → document edit → approval turn → tickets → session done.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Bus } from '../src/bus.js';
import { Processor } from '../src/processor/index.js';
import { apply, newState, type State } from '../src/fold/index.js';
import { snapshotEvents } from '../src/snapshot.js';
import { PlanningOrchestrator, resumeStrandedTurns } from '../src/planning.js';
import { FakeEngine } from '../src/engine/fake.js';
import type { EventFrame } from '../src/wire/envelope.js';

let dir: string;
let store: InstanceType<typeof import('../src/store/index.js').EventStore>;
let bus: Bus;
let processor: Processor;
let projectsCreated = 0;
const recorded: EventFrame[] = [];

beforeEach(async () => {
  recorded.length = 0;
  projectsCreated = 0;
  dir = mkdtempSync(join(tmpdir(), 'composer-plan-'));
  const { EventStore } = await import('../src/store/index.js');
  store = new EventStore();
  await store.connect(dir);
  bus = new Bus(store);
  processor = new Processor(bus);
  bus.subscribe((frame) => recorded.push(frame));
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function createProject(name = 'alpha'): Promise<string> {
  const result = await processor.execute(undefined, { type: 'requestProjectCreate', name });
  if (!result.ok) throw new Error(result.rejection.message);
  projectsCreated += 1;
  return `P-${projectsCreated}`;
}

async function createSession(projectId: string): Promise<string> {
  const result = await processor.execute(projectId, {
    type: 'requestPlanningSessionCreate',
    projectId,
  });
  if (!result.ok) throw new Error(result.rejection.message);
  return 'S-1';
}

function session(projectId: string, sessionId: string) {
  const record = bus.state.byProject.get(projectId)?.planningSessions.get(sessionId);
  if (!record) throw new Error(`session ${sessionId} not in state`);
  return record;
}

function ticketBlock(t: {
  title: string;
  cardType?: string;
  key?: string;
  blockedBy?: string[];
  description?: string;
}): string {
  const fields: string[] = [];
  if (t.cardType !== undefined) fields.push(`cardType: ${t.cardType}`);
  if (t.key !== undefined) fields.push(`key: ${t.key}`);
  if (t.blockedBy !== undefined && t.blockedBy.length > 0) fields.push(`blockedBy: [${t.blockedBy.join(', ')}]`);
  return `#[${t.title}]\n\n---\n${fields.join('\n')}\n---\n${t.description ?? ''}`.trim();
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the condition never held');
}

// ---- Domain suite (v1 processor behavioral tests) ----

describe('planning commands', () => {
  let projectId: string;
  let sessionId: string;

  beforeEach(async () => {
    projectId = await createProject();
    sessionId = await createSession(projectId);
  });

  it('planning_session_creates_with_sequential_ids', async () => {
    expect(sessionId).toBe('S-1');
    const other = await createProject('beta');
    const second = await processor.execute(other, {
      type: 'requestPlanningSessionCreate',
      projectId: other,
    });
    expect(second.ok).toBe(true);
    const sessions = bus.state.byProject.get('P-2')?.planningSessions;
    expect([...(sessions?.keys() ?? [])]).toEqual(['S-1']);
  });

  it('planning_session_create_rejects_unknown_projects', async () => {
    const result = await processor.execute(undefined, {
      type: 'requestPlanningSessionCreate',
      projectId: 'P-99',
    });
    expect(result).toEqual({
      ok: false,
      rejection: { code: 'unknownProject', message: 'Unknown project P-99' },
    });
  });

  it('user_messages_get_sequential_transcript_indexes', async () => {
    const first = await processor.execute(projectId, {
      type: 'requestUserMessage',
      sessionId,
      text: 'hello',
    });
    expect(first.ok).toBe(true);
    const message = (recorded.at(-1)?.body as { message: { index: number; role: string } }).message;
    expect(message.index).toBe(1);
    expect(message.role).toBe('user');

    // An agent reply shares the same transcript sequence.
    await bus.publish(projectId, 'agentMessageComplete', {
      sessionId,
      message: { index: 2, role: 'agent', text: 'reply', at: '2026-09-05T00:00:00.000000Z' },
    });

    const third = await processor.execute(projectId, {
      type: 'requestUserMessage',
      sessionId,
      text: 'next',
    });
    expect(third.ok).toBe(true);
    expect((recorded.at(-1)?.body as { message: { index: number } }).message.index).toBe(3);

    const unknown = await processor.execute(projectId, {
      type: 'requestUserMessage',
      sessionId: 'S-99',
      text: 'hi',
    });
    expect(unknown).toEqual({
      ok: false,
      rejection: { code: 'unknownSession', message: 'Unknown session S-99' },
    });

    const blank = await processor.execute(projectId, {
      type: 'requestUserMessage',
      sessionId,
      text: '  ',
    });
    expect(blank).toEqual({
      ok: false,
      rejection: { code: 'invalidCommand', message: 'Message text is required' },
    });
  });

  it('an_opposite_role_message_cannot_replace_an_occupied_index', async () => {
    await processor.execute(projectId, {
      type: 'requestUserMessage',
      sessionId,
      text: 'keep me',
    });
    await bus.publish(projectId, 'agentMessageComplete', {
      sessionId,
      message: { index: 1, role: 'agent', text: 'late reply', at: '2026-09-05T00:00:00.000000Z' },
    });

    expect(session(projectId, sessionId).messages).toMatchObject([
      { index: 1, role: 'user', text: 'keep me' },
      { index: 2, role: 'agent', text: 'late reply' },
    ]);
  });

  it('plan_document_update_replaces_the_document_wholesale', async () => {
    const first = await processor.execute(projectId, {
      type: 'requestPlanDocumentUpdate',
      sessionId,
      document: '<plan>\n# v1\n</plan>',
    });
    expect(first.ok).toBe(true);
    expect(session(projectId, sessionId).planDocument).toBe('<plan>\n# v1\n</plan>');

    await processor.execute(projectId, {
      type: 'requestPlanDocumentUpdate',
      sessionId,
      document: '<plan>\n# v2\n</plan>',
    });
    expect(session(projectId, sessionId).planDocument).toBe('<plan>\n# v2\n</plan>');

    const unknown = await processor.execute(projectId, {
      type: 'requestPlanDocumentUpdate',
      sessionId: 'S-99',
      document: 'x',
    });
    expect(unknown).toEqual({
      ok: false,
      rejection: { code: 'unknownSession', message: 'Unknown session S-99' },
    });
  });

  it('create_tickets_emits_validated_cards_and_completes_the_session', async () => {
    // An existing card so the ids allocate after it (T-2..).
    const existing = await processor.execute(projectId, {
      type: 'requestCardCreate',
      card: { id: '', projectId, type: 'coding', title: 'existing', description: '', tags: [], pipelineId: '', stepId: '', blockedBy: [], stepStates: {}, createdAt: '', updatedAt: '' },
    });
    expect(existing.ok).toBe(true);

    const planDocument = [
      ticketBlock({ title: 'Alpha', cardType: 'coding', key: 'a' }),
      ticketBlock({ title: 'Beta', cardType: 'design', key: 'b', blockedBy: ['a', 'T-1'] }),
      ticketBlock({ title: 'Gamma', cardType: 'docs', blockedBy: ['b'] }),
    ].join('\n\n');
    await processor.execute(projectId, {
      type: 'requestPlanDocumentUpdate',
      sessionId,
      document: planDocument,
    });

    const result = await processor.execute(projectId, {
      type: 'requestTicketsCreate',
      sessionId,
      pipelineId: 'PL-1',
      document: planDocument,
    });
    expect(result).toEqual({ ok: true, cards: 3 });

    const kinds = recorded.map((frame) => frame.eventType).slice(-4);
    expect(kinds).toEqual([
      'cardsCommitted',
      'dependencyStateChanged',
      'dependencyStateChanged',
      'planningSessionCompleted',
    ]);

    const committed = recorded
      .filter((frame) => frame.eventType === 'cardsCommitted')
      .at(-1)?.body as { cards: { id: string; type: string; pipelineId: string; stepId: string; blockedBy: string[]; sessionId?: string }[] };
    expect(committed.cards).toHaveLength(3);
    const [alpha, beta, gamma] = committed.cards;
    expect(alpha).toMatchObject({ id: 'T-2', type: 'coding', pipelineId: 'PL-1', stepId: 'st-1' });
    expect(beta).toMatchObject({ id: 'T-3', type: 'design', blockedBy: ['T-2', 'T-1'] });
    expect(gamma).toMatchObject({ id: 'T-4', type: 'docs', blockedBy: ['T-3'] });
    expect(beta.sessionId).toBe(sessionId);

    // The cards live in state assigned to the default pipeline's first
    // stage with empty step states; the session is done.
    expect(session(projectId, sessionId).status).toBe('done');
    const card = bus.state.byProject.get(projectId)?.cards.get('T-3');
    expect(card?.pipelineId).toBe('PL-1');
    expect(card?.stepId).toBe('st-1');
    expect(card?.stepStates).toEqual({});
  });

  it('create_tickets_requires_a_known_target_pipeline', async () => {
    const document = ticketBlock({ title: 'Alpha' });
    await processor.execute(projectId, {
      type: 'requestPlanDocumentUpdate',
      sessionId,
      document,
    });
    expect(await processor.execute(projectId, {
      type: 'requestTicketsCreate',
      sessionId,
      pipelineId: 'PL-99',
      document,
    })).toEqual({
      ok: false,
      rejection: { code: 'unknownPipeline', message: 'Unknown pipeline PL-99' },
    });
  });

  it('create_tickets_rejects_invalid_input', async () => {
    const cases: { document: string; sessionId: string; message: string }[] = [
      { document: 'no tickets here — just prose', sessionId, message: 'No tickets provided' },
      {
        document: [ticketBlock({ title: 'Alpha', key: 'a' }), ticketBlock({ title: 'Beta', key: 'a' })].join('\n\n'),
        sessionId,
        message: 'Ticket keys must be unique',
      },
      {
        document: ticketBlock({ title: 'Alpha', key: 'a', blockedBy: ['a'] }),
        sessionId,
        message: "Ticket 'Alpha': a ticket cannot block itself",
      },
      {
        document: ticketBlock({ title: 'Alpha', key: 'a', blockedBy: ['T-99'] }),
        sessionId,
        message: "Ticket 'Alpha': blockedBy entry T-99 is neither an existing card nor a ticket key",
      },
      { document: ticketBlock({ title: 'Alpha' }), sessionId: 'S-99', message: 'Unknown session S-99' },
    ];
    for (const case_ of cases) {
      if (case_.sessionId === sessionId) {
        await processor.execute(projectId, {
          type: 'requestPlanDocumentUpdate',
          sessionId,
          document: case_.document,
        });
      }
      const result = await processor.execute(projectId, {
        type: 'requestTicketsCreate',
        sessionId: case_.sessionId,
        pipelineId: 'PL-1',
        document: case_.document,
      });
      expect(result).toEqual({
        ok: false,
        rejection: { code: case_.sessionId === 'S-99' ? 'unknownSession' : 'invalidCommand', message: case_.message },
      });
    }
  });

  it('done_session_rejects_document_updates_and_ticket_reemission', async () => {
    const document = ticketBlock({ title: 'Alpha', key: 'a' });
    await processor.execute(projectId, {
      type: 'requestPlanDocumentUpdate',
      sessionId,
      document,
    });
    const done = await processor.execute(projectId, {
      type: 'requestTicketsCreate',
      sessionId,
      pipelineId: 'PL-1',
      document,
    });
    expect(done).toEqual({ ok: true, cards: 1 });

    const doc = await processor.execute(projectId, {
      type: 'requestPlanDocumentUpdate',
      sessionId,
      document: 'late edit',
    });
    expect(doc).toEqual({
      ok: false,
      rejection: { code: 'invalidCommand', message: `Session ${sessionId} is done; its plan document is closed` },
    });

    const message = await processor.execute(projectId, {
      type: 'requestUserMessage',
      sessionId,
      text: 'more',
    });
    expect(message).toEqual({
      ok: false,
      rejection: { code: 'invalidCommand', message: `Session ${sessionId} is done; its transcript is closed` },
    });

    const again = await processor.execute(projectId, {
      type: 'requestTicketsCreate',
      sessionId,
      pipelineId: 'PL-1',
      document,
    });
    expect(again).toEqual({
      ok: false,
      rejection: { code: 'invalidCommand', message: `Session ${sessionId} is done; its tickets were already emitted` },
    });
  });

  it('the_planning_snapshot_replays_into_equal_state', async () => {
    await processor.execute(projectId, {
      type: 'requestUserMessage',
      sessionId,
      text: 'plan the board',
    });
    await processor.execute(projectId, {
      type: 'requestPlanDocumentUpdate',
      sessionId,
      document: ticketBlock({ title: 'Alpha', key: 'a' }),
    });
    await processor.execute(projectId, {
      type: 'requestTicketsCreate',
      sessionId,
      pipelineId: 'PL-1',
      document: ticketBlock({ title: 'Alpha', key: 'a' }),
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
    expect(stateOf(replayed)).toEqual(stateOf(bus.state));
  });

  function stateOf(state: State): unknown {
    return [...state.byProject.values()].map((project) => ({
      cards: [...project.cards.entries()].sort(([a], [b]) => a.localeCompare(b)),
      planningSessions: [...project.planningSessions.entries()],
      automation: [...project.automation.entries()],
    }));
  }
});

// ---- t10: a restart publishes the lost turn as a failure message ----

describe('resumeStrandedTurns', () => {
  it('publishes a failure message for a transcript that ends with a user message', async () => {
    const projectId = await createProject();
    const sessionId = await createSession(projectId);
    await processor.execute(projectId, {
      type: 'requestUserMessage',
      sessionId,
      text: 'plan the work',
    });

    const resumed = await resumeStrandedTurns(bus);
    expect(resumed).toBe(1);

    const transcript = session(projectId, sessionId).messages;
    expect(transcript.at(-1)).toMatchObject({
      role: 'agent',
      text: 'the server restarted before this turn could run — send your message again',
    });
    // It is a real durable message (index 2, after the user's).
    expect(recorded.at(-1)?.eventType).toBe('agentMessageComplete');
  });

  it('leaves sessions that do not end with a user message alone', async () => {
    const projectId = await createProject();
    const sessionId = await createSession(projectId);
    // An empty session and one whose last message is the agent's.
    await bus.publish(projectId, 'agentMessageComplete', {
      sessionId,
      message: { index: 1, role: 'agent', text: 'done earlier', at: new Date().toISOString() },
    });

    const resumed = await resumeStrandedTurns(bus);
    expect(resumed).toBe(0);
    expect(session(projectId, sessionId).messages).toHaveLength(1);
  });
});

// ---- The scripted-engine e2e (the S2 exit criteria) ----

describe('the planning turn', () => {
  let projectId: string;
  let sessionId: string;
  let engine: FakeEngine;

  beforeEach(async () => {
    projectId = await createProject();
    sessionId = await createSession(projectId);
    engine = new FakeEngine(processor);
    new PlanningOrchestrator(bus, engine, { serverUrl: 'http://127.0.0.1:0' }).start();
  });

  it('a_chat_turn_commits_the_edited_plan_document', async () => {
    engine.enqueue(async ({ spec, tools, emit }) => {
      expect(spec.projectDirectory).toContain('composer-planner-');
      expect(spec.planDocumentPath).toBe(`${spec.projectDirectory}/plan.md`);
      expect(spec.prompt).toContain('- PL-1: Standard coding card');
      emit({ kind: 'messageDelta', messageId: 'm1', delta: 'drafting ' });
      emit({ kind: 'messageDelta', messageId: 'm1', delta: 'the plan' });
      const result = await tools.editDocument('<plan><goal>board</goal></plan>');
      expect(result).toEqual({ ok: true });
      return 'drafted the plan';
    });

    const sent = await processor.execute(projectId, {
      type: 'requestUserMessage',
      sessionId,
      text: 'plan the board work',
    });
    expect(sent.ok).toBe(true);

    await waitUntil(() => session(projectId, sessionId).planDocument === '<plan><goal>board</goal></plan>');
    await waitUntil(() => session(projectId, sessionId).messages.at(-1)?.text === 'drafted the plan');

    // The reply streamed (deltas, ephemeral) and landed (complete, index 2).
    const deltas = recorded.filter((frame) => frame.eventType === 'agentMessageDelta');
    expect(deltas.map((frame) => (frame.body as { delta: string }).delta).join('')).toBe('drafting the plan');
    const complete = recorded.filter((frame) => frame.eventType === 'agentMessageComplete').at(-1);
    expect(complete?.body).toMatchObject({ sessionId, message: { index: 2, role: 'agent', text: 'drafted the plan' } });
    expect(recorded.findLastIndex((frame) => frame.eventType === 'planDocumentUpdated'))
      .toBeLessThan(recorded.findLastIndex((frame) => frame.eventType === 'agentMessageComplete'));
  });

  it('a_document_shaped_final_message_does_not_replace_the_plan_file', async () => {
    await processor.execute(projectId, {
      type: 'requestPlanDocumentUpdate',
      sessionId,
      document: '# Durable plan',
    });
    engine.enqueue(async () => '# Chat-only plan\n\nThis was not written to plan.md.');

    await processor.execute(projectId, {
      type: 'requestUserMessage',
      sessionId,
      text: 'revise it',
    });
    await waitUntil(() => session(projectId, sessionId).messages.at(-1)?.role === 'agent');

    expect(session(projectId, sessionId).planDocument).toBe('# Durable plan');
    expect(session(projectId, sessionId).messages.at(-1)?.text).toContain('# Chat-only plan');
  });

  it('two_messages_in_one_turn_get_distinct_indices_and_pair_with_their_deltas', async () => {
    engine.enqueue(async ({ emit }) => {
      emit({ kind: 'messageDelta', messageId: 'a', delta: 'first ' });
      emit({ kind: 'messageComplete', messageId: 'a', text: 'first reply' });
      emit({ kind: 'toolCall', toolCallId: 'tool-1', toolName: 'read_file', args: { path: 'README.md' } });
      emit({ kind: 'toolResult', toolCallId: 'tool-1', content: 'project readme', isError: false });
      emit({ kind: 'messageDelta', messageId: 'b', delta: 'second ' });
      // The turn's return value is its final message (FakeEngine rule).
      return 'second reply';
    });

    const sent = await processor.execute(projectId, {
      type: 'requestUserMessage',
      sessionId,
      text: 'say two things',
    });
    expect(sent.ok).toBe(true);
    await waitUntil(() => session(projectId, sessionId).messages.at(-1)?.text === 'second reply');

    const agentEvents = recorded
      .filter((frame) => frame.eventType === 'agentMessageDelta' || frame.eventType === 'agentMessageComplete')
      .map((frame) => ({
        type: frame.eventType,
        index: (frame.body as { messageIndex?: number; message?: { index?: number } }).messageIndex
          ?? (frame.body as { message?: { index?: number } }).message!.index!,
      }));
    // Deltas and their completion share one reserved index. The intermediate
    // completion is durable activity, but is published before the final reply.
    expect(agentEvents).toEqual([
      { type: 'agentMessageDelta', index: 2 },
      { type: 'agentMessageDelta', index: 3 },
      { type: 'agentMessageComplete', index: 2 },
      { type: 'agentMessageComplete', index: 3 },
    ]);
    expect(session(projectId, sessionId).messages).toMatchObject([
      { index: 1, role: 'user' },
      { index: 2, role: 'agent', text: 'first reply', activity: true, parentIndex: 1 },
      { index: 3, role: 'agent', text: 'second reply' },
    ]);
    expect(session(projectId, sessionId).toolCalls).toMatchObject([
      {
        toolCallId: 'tool-1',
        parentIndex: 1,
        toolName: 'read_file',
        summary: 'project readme',
      },
    ]);
  });

  it('an_approval_turn_lands_tickets_and_completes_the_session', async () => {
    const planDocument = [
      ticketBlock({ title: 'drag & drop', cardType: 'coding', key: 'k1', description: 'd1' }),
      ticketBlock({ title: 'docs', cardType: 'docs', blockedBy: ['k1'], description: 'd2' }),
    ].join('\n\n');
    engine.enqueue(async ({ tools }) => {
      const result = await tools.editDocument(planDocument);
      expect(result).toEqual({ ok: true });
      return 'drafted';
    });
    engine.enqueue(async ({ tools }) => {
      const result = await tools.createTickets('PL-1');
      expect(result).toEqual({ ok: true, cards: 2 });
      return 'committed';
    });

    await processor.execute(projectId, {
      type: 'requestUserMessage',
      sessionId,
      text: 'plan it',
    });
    await waitUntil(() => session(projectId, sessionId).planDocument !== '');

    await processor.execute(projectId, {
      type: 'requestUserMessage',
      sessionId,
      text: 'approved, commit',
    });
    await waitUntil(() => session(projectId, sessionId).status === 'done');

    const cards = bus.state.byProject.get(projectId)?.cards;
    expect([...(cards?.keys() ?? [])]).toEqual(['T-1', 'T-2']);
    expect(cards?.get('T-2')?.blockedBy).toEqual(['T-1'], 'in-batch keys remap onto card ids');
    expect(cards?.get('T-1')?.sessionId).toBe(sessionId);
  });

  it('a_message_sent_mid_turn_is_served_by_the_next_run', async () => {
    engine.enqueue(async ({ tools }) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await tools.editDocument('<plan>v1</plan>');
      return 'drafted';
    });
    engine.enqueue(async ({ tools }) => {
      await tools.editDocument('<plan>v2</plan>');
      return 'updated';
    });

    await processor.execute(projectId, {
      type: 'requestUserMessage',
      sessionId,
      text: 'plan it',
    });
    await processor.execute(projectId, {
      type: 'requestUserMessage',
      sessionId,
      text: 'also add the archive flow',
    });

    await waitUntil(() => session(projectId, sessionId).planDocument === '<plan>v2</plan>');
    expect(engine.toolCalls).toHaveLength(2);
    expect(engine.toolCalls[1]?.prompt).toContain('also add the archive flow');
  });

  it('a_failed_turn_publishes_the_failure_as_an_agent_message', async () => {
    engine.enqueue(async () => ({ error: 'engine exploded' }));
    await processor.execute(projectId, {
      type: 'requestUserMessage',
      sessionId,
      text: 'plan it',
    });
    await waitUntil(() => session(projectId, sessionId).messages.at(-1)?.role === 'agent');
    expect(session(projectId, sessionId).messages.at(-1)?.text).toContain('engine exploded');
  });

  it('the_engine_session_id_is_kept_for_continuity', async () => {
    engine.enqueue(async () => 'first');
    engine.enqueue(async () => 'second');
    await processor.execute(projectId, {
      type: 'requestUserMessage',
      sessionId,
      text: 'one',
    });
    await waitUntil(() => session(projectId, sessionId).messages.at(-1)?.text === 'first');
    await processor.execute(projectId, {
      type: 'requestUserMessage',
      sessionId,
      text: 'two',
    });
    await waitUntil(() => session(projectId, sessionId).messages.at(-1)?.text === 'second');
    expect(engine.toolCalls[0]?.engineSessionId).toBeUndefined();
    expect(engine.toolCalls[1]?.engineSessionId).toBe('fake-S-1');
  });
});

// ---- The per-agent model override (settings → the turn spec) ----

describe('per-agent model wiring', () => {
  it('the agent override wins over the default model', async () => {
    const projectId = await createProject();
    const sessionId = await createSession(projectId);
    const engine = new FakeEngine(processor);
    const orchestrator = new PlanningOrchestrator(bus, engine, {
      serverUrl: 'http://127.0.0.1:0',
      getModel: () => ({ model: 'fallback-model', models: { planner: 'planner-model' } }),
    });
    orchestrator.start();
    engine.enqueue(async () => 'planned');

    const sent = await processor.execute(projectId, {
      type: 'requestUserMessage',
      sessionId,
      text: 'plan it',
    });
    expect(sent.ok).toBe(true);
    await waitUntil(() => session(projectId, sessionId).messages.at(-1)?.text === 'planned');

    expect(engine.toolCalls.at(-1)?.model).toBe('planner-model');
    orchestrator.stop();
  });

  it('without an override the default model rides the spec', async () => {
    const projectId = await createProject();
    const sessionId = await createSession(projectId);
    const engine = new FakeEngine(processor);
    const orchestrator = new PlanningOrchestrator(bus, engine, {
      serverUrl: 'http://127.0.0.1:0',
      getModel: () => ({ model: 'fallback-model', models: { coder: 'coder-model' } }),
    });
    orchestrator.start();
    engine.enqueue(async () => 'planned');

    const sent = await processor.execute(projectId, {
      type: 'requestUserMessage',
      sessionId,
      text: 'plan it',
    });
    expect(sent.ok).toBe(true);
    await waitUntil(() => session(projectId, sessionId).messages.at(-1)?.text === 'planned');

    expect(engine.toolCalls.at(-1)?.model).toBe('fallback-model');
    orchestrator.stop();
  });
});
