// The pipeline runner: authoring, the sequential walk (command/agent/
// human), gates, stop, and boot cancel — v1's runner behavioral suite
// re-expressed on the FakeEngine. Command steps run real child processes
// (`true` / `false` / `sleep`).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Bus } from '../src/bus.js';
import { Processor } from '../src/processor.js';
import { apply, newState, type State } from '../src/fold.js';
import { snapshotEvents } from '../src/snapshot.js';
import { PipelineRunner } from '../src/runner.js';
import { cancelInterruptedRuns, seedDefaultPipeline } from '../src/pipelines.js';
import { FakeEngine } from '../src/engine/fake.js';
import type { EventFrame } from '../src/wire/envelope.js';
import type { Pipeline } from '../src/wire/models.js';

let dir: string;
let store: InstanceType<typeof import('../src/store.js').EventStore>;
let bus: Bus;
let processor: Processor;
const recorded: EventFrame[] = [];

beforeEach(async () => {
  recorded.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'composer-run-'));
  const { EventStore } = await import('../src/store.js');
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

async function createProject(): Promise<string> {
  const name = `project-${bus.state.projects.size + 1}`;
  const result = await processor.execute(undefined, {
    type: 'requestProjectCreate',
    name,
    directory: dir,
  });
  if (!result.ok) throw new Error(result.rejection.message);
  return `P-${bus.state.projects.size}`;
}

async function createCard(projectId: string): Promise<string> {
  const result = await processor.execute(projectId, {
    type: 'requestCardCreate',
    card: { id: '', projectId, type: 'coding', title: 'wired', description: '', tags: [], stage: 'new', blockedBy: [], subState: {}, retries: {}, createdAt: '', updatedAt: '' },
  });
  if (!result.ok) throw new Error(result.rejection.message);
  return 'T-1';
}

function pipelineFixture(id: string, steps: Pipeline['steps']): Pipeline {
  return { id, projectId: '', name: 'Standard coding card', steps, updatedAt: '' };
}

const coderStep = (id: string): Pipeline['steps'][number] => ({
  id,
  kind: 'agent',
  agentKind: 'coder',
  instructions: 'Implement the card.',
});
const commandStep = (id: string, command: string): Pipeline['steps'][number] => ({
  id,
  kind: 'command',
  command,
  description: 'Run checks',
});
const humanStep = (id: string): Pipeline['steps'][number] => ({
  id,
  kind: 'human',
  description: 'Approval',
});

async function savePipeline(projectId: string, pipeline: Pipeline): Promise<string> {
  const result = await processor.execute(projectId, { type: 'requestPipelineSave', pipeline });
  if (!result.ok) throw new Error(result.rejection.message);
  const saved = recorded.filter((frame) => frame.eventType === 'pipelineSaved').at(-1)!
    .body as { pipeline: { id: string } };
  return saved.pipeline.id;
}

function runOf(projectId: string, cardId: string) {
  return bus.state.byProject.get(projectId)?.pipelineRuns.get(cardId);
}

function cardOf(projectId: string, cardId: string) {
  const card = bus.state.byProject.get(projectId)?.cards.get(cardId);
  if (!card) throw new Error(`card ${cardId} not in state`);
  return card;
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the condition never held');
}

describe('pipeline authoring', () => {
  let projectId: string;

  beforeEach(async () => {
    projectId = await createProject();
  });

  it('pipeline_save_allocates_ids_and_emits_pipeline_saved', async () => {
    // The project's creation seeded PL-1, so user saves allocate from PL-2.
    const result = await processor.execute(projectId, {
      type: 'requestPipelineSave',
      pipeline: pipelineFixture('', [coderStep('st-1'), humanStep('st-2')]),
    });
    expect(result.ok).toBe(true);
    const saved = recorded.filter((frame) => frame.eventType === 'pipelineSaved').at(-1)!
      .body as { pipeline: { id: string; updatedAt: string } };
    expect(saved.pipeline.id).toBe('PL-2');
    expect(saved.pipeline.updatedAt).not.toBe('');

    await processor.execute(projectId, {
      type: 'requestPipelineSave',
      pipeline: pipelineFixture('', [coderStep('st-1')]),
    });
    const second = recorded.filter((frame) => frame.eventType === 'pipelineSaved').at(-1)!
      .body as { pipeline: { id: string } };
    expect(second.pipeline.id).toBe('PL-3', 'ids allocate sequentially');
  });

  it('pipeline_save_upserts_a_known_id', async () => {
    await savePipeline(projectId, pipelineFixture('PL-7', [coderStep('st-1')]));
    await savePipeline(projectId, pipelineFixture('PL-7', [coderStep('st-1'), commandStep('st-2', 'true')]));
    const pipelines = bus.state.byProject.get(projectId)?.pipelines;
    expect(pipelines?.get('PL-7')?.steps).toHaveLength(2);
    expect(pipelines?.size).toBe(2, 'the seeded default plus the upsert');
  });

  it('pipeline_save_validates_shape_and_per_kind_fields', async () => {
    const cases: { steps: Pipeline['steps']; message: string }[] = [
      { steps: [], message: 'A pipeline needs at least one step' },
      { steps: [{ ...coderStep(''), agentKind: 'coder', instructions: 'x' }], message: 'Step 1 needs an id' },
      { steps: [coderStep('st-1'), coderStep('st-1')], message: "Step id 'st-1' appears twice" },
      { steps: [{ id: 'st-1', kind: 'agent', instructions: 'x' }], message: 'Step 1: an agent step needs an agentKind' },
      { steps: [{ id: 'st-1', kind: 'agent', agentKind: 'coder' }], message: 'Step 1: an agent step needs instructions' },
      { steps: [{ id: 'st-1', kind: 'command', description: 'x' }], message: 'Step 1: a command step needs a command' },
      { steps: [{ id: 'st-1', kind: 'human', description: '  ' }], message: 'Step 1: a human step needs a description (the approval prompt)' },
    ];
    for (const case_ of cases) {
      const result = await processor.execute(projectId, {
        type: 'requestPipelineSave',
        pipeline: pipelineFixture('', case_.steps),
      });
      expect(result).toEqual({ ok: false, rejection: { code: 'invalidCommand', message: case_.message } });
    }

    const noName = await processor.execute(projectId, {
      type: 'requestPipelineSave',
      pipeline: pipelineFixture('', [coderStep('st-1')]),
    });
    void noName;
    const blankName = await processor.execute(projectId, {
      type: 'requestPipelineSave',
      pipeline: { ...pipelineFixture('', [coderStep('st-1')]), name: '  ' },
    });
    expect(blankName).toEqual({
      ok: false,
      rejection: { code: 'invalidCommand', message: 'Pipeline name is required' },
    });
  });

  it('pipeline_delete_tombstones_and_the_boot_seed_stays_dead', async () => {
    // The project's seed (from creation) is PL-1; delete it.
    const result = await processor.execute(projectId, { type: 'requestPipelineDelete', pipelineId: 'PL-1' });
    expect(result.ok).toBe(true);
    const project = bus.state.byProject.get(projectId)!;
    expect(project.pipelines.has('PL-1')).toBe(false);
    expect(project.deletedPipelines.has('PL-1')).toBe(true);
    await seedDefaultPipeline(bus, projectId);
    expect(project.pipelines.has('PL-1')).toBe(false, 'the tombstone keeps the seed dead');

    // An id is reusable after deletion; the re-save clears the tombstone.
    await savePipeline(projectId, pipelineFixture('PL-1', [coderStep('st-1')]));
    expect(project.deletedPipelines.has('PL-1')).toBe(false);

    const unknown = await processor.execute(projectId, { type: 'requestPipelineDelete', pipelineId: 'PL-99' });
    expect(unknown).toEqual({
      ok: false,
      rejection: { code: 'unknownPipeline', message: 'Unknown pipeline PL-99' },
    });
  });
});

describe('the pipeline runner', () => {
  let projectId: string;
  let cardId: string;
  let engine: FakeEngine;
  let runner: PipelineRunner;

  beforeEach(async () => {
    projectId = await createProject();
    cardId = await createCard(projectId);
    engine = new FakeEngine(processor);
    runner = new PipelineRunner(bus, processor, engine, { serverUrl: 'http://127.0.0.1:0' });
    runner.start();
  });

  afterEach(async () => {
    // A test may end mid-run (e.g. a re-run whose step is still driving);
    // stop and let the drives unwind before the file-level afterEach
    // closes the store, so no in-flight append races the close.
    runner.stop();
    await runner.drain();
  });

  it('run_pipeline_validates_scope_directory_and_agent_kinds', async () => {
    await savePipeline(projectId, pipelineFixture('', [coderStep('st-1')]));
    const card = cardOf(projectId, cardId);
    void card;

    const unknownPipeline = await processor.execute(projectId, {
      type: 'requestPipelineRun',
      pipelineId: 'PL-99',
      cardId,
    });
    expect(unknownPipeline).toEqual({
      ok: false,
      rejection: { code: 'unknownPipeline', message: 'Unknown pipeline PL-99' },
    });

    const unknownCard = await processor.execute(projectId, {
      type: 'requestPipelineRun',
      pipelineId: 'PL-1',
      cardId: 'T-99',
    });
    expect(unknownCard).toEqual({
      ok: false,
      rejection: { code: 'unknownCard', message: 'Unknown card T-99' },
    });

    // No directory: the project was created without one.
    await processor.execute(undefined, { type: 'requestProjectCreate', name: 'bare' });
    await processor.execute('P-2', {
      type: 'requestCardCreate',
      card: { id: '', projectId: 'P-2', type: 'coding', title: 'x', description: '', tags: [], stage: 'new', blockedBy: [], subState: {}, retries: {}, createdAt: '', updatedAt: '' },
    });
    await savePipeline('P-2', pipelineFixture('', [coderStep('st-1')]));
    const noDirectory = await processor.execute('P-2', {
      type: 'requestPipelineRun',
      pipelineId: 'PL-1',
      cardId: 'T-1',
    });
    expect(noDirectory).toEqual({
      ok: false,
      rejection: { code: 'invalidCommand', message: 'Project P-2 has no directory set' },
    });

    await savePipeline(projectId, pipelineFixture('PL-9', [{ ...coderStep('st-1'), agentKind: 'designer' }]));
    const unknownKind = await processor.execute(projectId, {
      type: 'requestPipelineRun',
      pipelineId: 'PL-9',
      cardId,
    });
    expect(unknownKind).toEqual({
      ok: false,
      rejection: { code: 'unknownAgentKind', message: "Agent kind 'designer' has no implementation yet" },
    });
  });

  it('a_pipeline_walks_hands_off_parks_at_the_gate_and_done_on_approval', async () => {
    engine.enqueue(async ({ spec }) => {
      expect(spec.agentName).toBe('composer-coder');
      expect(spec.prompt).toContain(`Implement card ${cardId}`);
      return 'implemented the card';
    });
    const pipelineId = await savePipeline(projectId, pipelineFixture('', [
      coderStep('st-1'),
      commandStep('st-2', 'true'),
      humanStep('st-3'),
    ]));

    const started = await processor.execute(projectId, {
      type: 'requestPipelineRun',
      pipelineId,
      cardId,
    });
    expect(started.ok).toBe(true);

    // The agent step moves the card to the implement lane; the command
    // step to validation; the gate parks it waiting at approval. The
    // last projection of the park is the gate's running sub-state.
    await waitUntil(() => cardOf(projectId, cardId).subState['humanReview'] === 'running');
    expect(runOf(projectId, cardId)?.status).toBe('waiting');
    expect(cardOf(projectId, cardId).stage).toBe('approval');
    expect(cardOf(projectId, cardId).subState['implement']).toBe('ok');
    expect(cardOf(projectId, cardId).subState['runValidation']).toBe('ok');
    expect(cardOf(projectId, cardId).subState['humanReview']).toBe('running');

    // The agent session is real: started, one reply, ended.
    const project = bus.state.byProject.get(projectId)!;
    expect(project.agentSessions.size).toBe(1);
    const session = [...project.agentSessions.values()][0]!;
    expect(session.cardId).toBe(cardId);
    expect(session.transcript.some((entry) => entry.kind === 'message' && entry.message.text === 'implemented the card')).toBe(true);
    expect(session.status).toBe('ended');

    const approved = await processor.execute(projectId, {
      type: 'requestPipelineGateRespond',
      cardId,
      approved: true,
    });
    expect(approved.ok).toBe(true);

    await waitUntil(() => cardOf(projectId, cardId).stage === 'done');
    expect(runOf(projectId, cardId)).toBeUndefined();

    const kinds = recorded.map((frame) => frame.eventType);
    expect(kinds.filter((kind) => kind === 'pipelineRunEnded')).toHaveLength(1);
    expect(recorded.findLast((frame) => frame.eventType === 'pipelineRunEnded')?.body)
      .toMatchObject({ cardId, status: 'completed' });
    // Stream order: the terminal move rides after the run's end.
    const endIndex = recorded.findLastIndex((frame) => frame.eventType === 'pipelineRunEnded');
    expect(recorded[endIndex + 1]?.eventType).toBe('cardMoved');
  });

  it('a_gate_rejection_routes_the_card_back_to_its_implement_lane', async () => {
    engine.enqueue(async () => 'implemented');
    const pipelineId = await savePipeline(projectId, pipelineFixture('', [coderStep('st-1'), humanStep('st-2')]));
    await processor.execute(projectId, { type: 'requestPipelineRun', pipelineId, cardId });
    await waitUntil(() => runOf(projectId, cardId)?.status === 'waiting');

    const rejected = await processor.execute(projectId, {
      type: 'requestPipelineGateRespond',
      cardId,
      approved: false,
      comment: 'needs tests',
    });
    expect(rejected.ok).toBe(true);

    await waitUntil(() => cardOf(projectId, cardId).stage === 'coding');
    expect(cardOf(projectId, cardId).rejectionComment).toBe('needs tests');
    const ended = recorded.findLast((frame) => frame.eventType === 'pipelineRunEnded')?.body as { status: string };
    expect(ended.status).toBe('completed', 'a rejected gate completes the run; the routing is the rejection');
  });

  it('the_workers_walk_their_own_lanes_and_stages', async () => {
    // coder → tester → reviewer → security → gate: each agent kind loads
    // its shipped agent, works its lane, and checks its own checklist stage.
    engine.enqueue(async ({ spec }) => {
      expect(spec.agentName).toBe('composer-coder');
      expect(spec.mcpTools).toBe('worker');
      expect(spec.prompt).toContain(`Implement card ${cardId}`);
      return 'implemented';
    });
    engine.enqueue(async ({ spec }) => {
      expect(spec.agentName).toBe('composer-tester');
      expect(spec.prompt).toContain(`Verify card ${cardId}`);
      return 'tests pass';
    });
    engine.enqueue(async ({ spec }) => {
      expect(spec.agentName).toBe('composer-reviewer');
      expect(spec.prompt).toContain(`Review card ${cardId}`);
      return 'approved';
    });
    engine.enqueue(async ({ spec }) => {
      expect(spec.agentName).toBe('composer-security');
      expect(spec.prompt).toContain(`Security-review card ${cardId}`);
      return 'no findings';
    });
    const workerStep = (id: string, agentKind: string): Pipeline['steps'][number] => ({
      id,
      kind: 'agent',
      agentKind,
      instructions: 'Do your part.',
    });
    const pipelineId = await savePipeline(projectId, pipelineFixture('', [
      coderStep('st-1'),
      workerStep('st-2', 'tester'),
      workerStep('st-3', 'reviewer'),
      workerStep('st-4', 'security'),
      humanStep('st-5'),
    ]));
    const started = await processor.execute(projectId, { type: 'requestPipelineRun', pipelineId, cardId });
    expect(started.ok).toBe(true);

    await waitUntil(() => cardOf(projectId, cardId).subState['humanReview'] === 'running');
    expect(cardOf(projectId, cardId).stage).toBe('approval');
    expect(cardOf(projectId, cardId).subState).toMatchObject({
      implement: 'ok',
      runValidation: 'ok',
      reviewChanges: 'ok',
      securityReview: 'ok',
      humanReview: 'running',
    });

    // Each step's session names its kind on the wire (ids allocate A-N in
    // walk order) — what the desktop's session list folds.
    const startedKinds = recorded
      .filter((frame) => frame.eventType === 'agentSessionStarted')
      .map((frame) => (frame.body as { agentKind: string }).agentKind);
    expect(startedKinds).toEqual(['coder', 'tester', 'reviewer', 'security']);

    await processor.execute(projectId, { type: 'requestPipelineGateRespond', cardId, approved: true });
    await waitUntil(() => cardOf(projectId, cardId).stage === 'done');
    expect(cardOf(projectId, cardId).subState['securityReview']).toBe('ok');
  });

  it('a_security_step_projects_nothing_on_a_card_type_without_the_lane', async () => {
    // Security is code-only: on a docs card the run completes but the
    // card keeps its lane and the checklist grows no securityReview key.
    const docsResult = await processor.execute(projectId, {
      type: 'requestCardCreate',
      card: { id: '', projectId, type: 'docs', title: 'guide', description: '', tags: [], stage: 'new', blockedBy: [], subState: {}, retries: {}, createdAt: '', updatedAt: '' },
    });
    expect(docsResult.ok).toBe(true);
    const docsCardId = 'T-2';
    engine.enqueue(async () => 'no findings');
    const pipelineId = await savePipeline(projectId, pipelineFixture('PL-9', [{
      id: 'st-1',
      kind: 'agent',
      agentKind: 'security',
      instructions: 'Security-review the card.',
    }]));
    const started = await processor.execute(projectId, { type: 'requestPipelineRun', pipelineId, cardId: docsCardId });
    expect(started.ok).toBe(true);

    await waitUntil(() => runOf(projectId, docsCardId) === undefined);
    const ended = recorded.findLast((frame) => frame.eventType === 'pipelineRunEnded')?.body as { status: string };
    expect(ended.status).toBe('completed');
    expect(cardOf(projectId, docsCardId).stage).toBe('new');
    expect(cardOf(projectId, docsCardId).subState).not.toHaveProperty('securityReview');
  });

  it('a_failed_command_step_fails_the_run_and_records_the_retry', async () => {
    const pipelineId = await savePipeline(projectId, pipelineFixture('', [commandStep('st-1', 'echo boom >&2; false')]));
    const started = await processor.execute(projectId, {
      type: 'requestPipelineRun',
      pipelineId,
      cardId,
    });
    expect(started.ok).toBe(true);

    await waitUntil(() => runOf(projectId, cardId) === undefined);
    expect(cardOf(projectId, cardId).retries['runValidation']).toBe(1);
    const ended = recorded.findLast((frame) => frame.eventType === 'pipelineRunEnded')!.body as {
      status: string;
      error?: string;
    };
    expect(ended.status).toBe('failed');
    expect(ended.error).toContain('exit code 1');
    expect(ended.error).toContain('boom');
    expect(bus.state.byProject.get(projectId)?.latestRuns.get(cardId)).toMatchObject({
      pipelineId,
      status: 'failed',
      error: expect.stringContaining('boom'),
    });

    // Re-run is the recovery story (D5): the same run command works again.
    const again = await processor.execute(projectId, {
      type: 'requestPipelineRun',
      pipelineId,
      cardId,
    });
    expect(again.ok).toBe(true);
  });

  it('stop_ends_the_run_cancelled_and_kills_the_child', async () => {
    const pipelineId = await savePipeline(projectId, pipelineFixture('', [commandStep('st-1', 'sleep 30')]));
    await processor.execute(projectId, { type: 'requestPipelineRun', pipelineId, cardId });
    await waitUntil(() => cardOf(projectId, cardId).subState['runValidation'] === 'running');

    const stopped = await processor.execute(projectId, { type: 'requestPipelineStop', cardId });
    expect(stopped.ok).toBe(true);

    await waitUntil(() => runOf(projectId, cardId) === undefined);
    // The card keeps its last position; nothing publishes after the cancel.
    expect(cardOf(projectId, cardId).stage).toBe('validation');
    const endCount = recorded.filter((frame) => frame.eventType === 'pipelineRunEnded').length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(recorded.filter((frame) => frame.eventType === 'pipelineRunEnded')).toHaveLength(endCount);
    expect(recorded.findLast((frame) => frame.eventType === 'pipelineRunEnded')?.body)
      .toMatchObject({ status: 'cancelled' });

    const notRunning = await processor.execute(projectId, { type: 'requestPipelineStop', cardId });
    expect(notRunning).toEqual({
      ok: false,
      rejection: { code: 'pipelineNotRunning', message: `Card ${cardId} has no running pipeline` },
    });
  });

  it('boot_cancels_interrupted_runs', async () => {
    // A run interrupted mid-step: the fold holds the progress.
    await bus.publish(projectId, 'pipelineRunStarted', { cardId, pipelineId: 'PL-1' });
    await bus.publish(projectId, 'pipelineStepStarted', { cardId, pipelineId: 'PL-1', stepId: 'st-1', kind: 'agent' });
    expect(runOf(projectId, cardId)?.status).toBe('running');

    const cancelled = await cancelInterruptedRuns(bus);
    expect(cancelled).toBe(1);
    expect(runOf(projectId, cardId)).toBeUndefined();
  });

  it('terminal_run_health_survives_a_snapshot', async () => {
    runner.stop();
    await bus.publish(projectId, 'pipelineRunStarted', { cardId, pipelineId: 'PL-1' });
    await bus.publish(projectId, 'pipelineRunEnded', {
      cardId,
      pipelineId: 'PL-1',
      status: 'failed',
      error: 'build failed',
    });

    const replayed = newState();
    for (const frame of snapshotEvents(bus.state)) {
      apply(replayed, {
        id: frame.id,
        ...(frame.projectId !== undefined ? { projectId: frame.projectId } : {}),
        occurredAt: frame.occurredAt,
        name: frame.eventType,
        body: frame.body,
      });
    }

    expect(replayed.byProject.get(projectId)?.latestRuns.get(cardId)).toEqual(
      bus.state.byProject.get(projectId)?.latestRuns.get(cardId),
    );
  });

  it('the_pipeline_snapshot_replays_into_equal_state', async () => {
    engine.enqueue(async () => 'implemented');
    const pipelineId = await savePipeline(projectId, pipelineFixture('', [coderStep('st-1'), humanStep('st-2')]));
    await processor.execute(projectId, { type: 'requestPipelineRun', pipelineId, cardId });
    await waitUntil(() => runOf(projectId, cardId)?.status === 'waiting');
    await processor.execute(projectId, {
      type: 'requestPipelineSave',
      pipeline: pipelineFixture('PL-5', [commandStep('st-1', 'true')]),
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

    const kinds = snapshot.map((frame) => frame.eventType);
    expect(kinds).toContain('pipelineSaved');
    expect(kinds).toContain('pipelineRunStarted');
    expect(kinds).toContain('pipelineStepStarted');
    expect(kinds).toContain('agentSessionStarted');
  });

  function stateOf(state: State): unknown {
    return [...state.byProject.values()].map((project) => ({
      cards: [...project.cards.entries()].sort(([a], [b]) => a.localeCompare(b)),
      planningSessions: [...project.planningSessions.entries()],
      agentSessions: [...project.agentSessions.entries()],
      pipelines: [...project.pipelines.entries()].sort(([a], [b]) => a.localeCompare(b)),
      deletedPipelines: [...project.deletedPipelines].sort(),
      pipelineRuns: [...project.pipelineRuns.entries()],
      latestRuns: [...project.latestRuns.entries()],
      automation: [...project.automation.entries()],
    }));
  }
});
