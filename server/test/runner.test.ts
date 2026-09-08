// The pipeline runner: staged authoring, the sequential walk (command/
// agent/human), stage transitions, gates, stop, boot cancel, and the
// stage outcomes (S36: the report command, the backward return, the
// required-outcome rule) — the runner behavioral suite re-expressed on
// the FakeEngine for Phase 10's run records. Command steps run real child
// processes (`true` / `false` / `sleep`).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Bus } from '../src/bus.js';
import { Processor } from '../src/processor/index.js';
import { apply, newState, type State } from '../src/fold/index.js';
import { snapshotEvents } from '../src/snapshot.js';
import { PipelineRunner } from '../src/runner/index.js';
import { cancelInterruptedRuns, seedDefaultPipeline } from '../src/pipelines.js';
import { FakeEngine } from '../src/engine/fake.js';
import type { EventFrame } from '../src/wire/envelope.js';
import type { Pipeline, PipelineStage, PipelineStep } from '../src/wire/models.js';

let dir: string;
let store: InstanceType<typeof import('../src/store/index.js').EventStore>;
let bus: Bus;
let processor: Processor;
const recorded: EventFrame[] = [];

beforeEach(async () => {
  recorded.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'composer-run-'));
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

async function createCard(projectId: string, title = 'wired'): Promise<string> {
  const result = await processor.execute(projectId, {
    type: 'requestCardCreate',
    card: {
      id: '',
      projectId,
      type: 'coding',
      title,
      description: '',
      tags: [],
      pipelineId: '',
      stageId: '',
      blockedBy: [],
      stepStates: {},
      createdAt: '',
      updatedAt: '',
    },
  });
  if (!result.ok) throw new Error(result.rejection.message);
  const events = recorded.filter((frame) => frame.eventType === 'cardCreated');
  return (events.at(-1)!.body as { card: { id: string } }).card.id;
}

/** A small staged pipeline: implement → check → approve → done. */
const STAGE_IMPLEMENT = 'p-1';
const STAGE_CHECK = 'p-2';
const STAGE_APPROVE = 'p-3';
const STAGE_DONE = 'p-4';

function defaultStages(): PipelineStage[] {
  return [
    { id: STAGE_IMPLEMENT, label: 'Implementation', kanbanVisible: true },
    { id: STAGE_CHECK, label: 'Validation', kanbanVisible: true },
    { id: STAGE_APPROVE, label: 'Approval', kanbanVisible: true, errorReturnToStageId: STAGE_IMPLEMENT },
    { id: STAGE_DONE, label: 'Done', kanbanVisible: true, terminal: true },
  ];
}

function pipelineFixture(
  id: string,
  steps: PipelineStep[],
  stages: PipelineStage[] = defaultStages(),
  name = 'Standard coding card',
): Pipeline {
  return { id, projectId: '', name, revision: 0, stages, steps, updatedAt: '' };
}

const coderStep = (id: string, stageId = STAGE_IMPLEMENT): PipelineStep => ({
  id,
  kind: 'agent',
  stageId,
  agentKind: 'coder',
  instructions: 'Implement the card.',
});
const commandStep = (id: string, command: string, stageId = STAGE_CHECK): PipelineStep => ({
  id,
  kind: 'command',
  stageId,
  command,
  description: 'Run checks',
});
const humanStep = (id: string, stageId = STAGE_APPROVE): PipelineStep => ({
  id,
  kind: 'human',
  stageId,
  description: 'Approval',
});

async function savePipeline(projectId: string, pipeline: Pipeline): Promise<string> {
  const result = await processor.execute(projectId, { type: 'requestPipelineSave', pipeline });
  if (!result.ok) throw new Error(result.rejection.message);
  const saved = recorded.filter((frame) => frame.eventType === 'pipelineSaved').at(-1)!
    .body as { pipeline: { id: string; revision: number } };
  return saved.pipeline.id;
}

/** Assigns the card to the pipeline (its run target) and starts a run. */
async function runOn(projectId: string, pipelineId: string, cardId: string) {
  const assigned = await processor.execute(projectId, {
    type: 'requestCardPipelineAssign',
    cardId,
    pipelineId,
  });
  if (!assigned.ok) throw new Error(assigned.rejection.message);
  return processor.execute(projectId, { type: 'requestPipelineRun', cardId });
}

function activeRunOf(projectId: string, cardId: string) {
  const project = bus.state.byProject.get(projectId);
  const runId = project?.activeRuns.get(cardId);
  return runId !== undefined ? project?.runs.get(runId) : undefined;
}

function runEndedBody(projectId: string) {
  return recorded.findLast((frame) => frame.eventType === 'pipelineRunEnded')?.body as {
    runId: string;
    cardId: string;
    pipelineId: string;
    revision: number;
    status: string;
    error?: string;
  };
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

  it('pipeline_save_allocates_ids_revisions_and_emits_pipeline_saved', async () => {
    // The project's creation seeded PL-1 (revision 1), so user saves allocate from PL-2.
    const result = await processor.execute(projectId, {
      type: 'requestPipelineSave',
      pipeline: pipelineFixture('', [coderStep('st-1'), humanStep('st-2')]),
    });
    expect(result.ok).toBe(true);
    const saved = recorded.filter((frame) => frame.eventType === 'pipelineSaved').at(-1)!
      .body as { pipeline: { id: string; revision: number; updatedAt: string } };
    expect(saved.pipeline.id).toBe('PL-2');
    expect(saved.pipeline.revision).toBe(1);
    expect(saved.pipeline.updatedAt).not.toBe('');

    // An unchanged save is a no-op; a changed save allocates revision 2.
    const unchanged = await processor.execute(projectId, {
      type: 'requestPipelineSave',
      pipeline: pipelineFixture('PL-2', [coderStep('st-1'), humanStep('st-2')]),
    });
    expect(unchanged).toEqual({ ok: true });
    expect(recorded.filter((frame) => frame.eventType === 'pipelineSaved')).toHaveLength(
      2,
      'the seed plus PL-2; the unchanged save emits nothing',
    );

    const changed = await processor.execute(projectId, {
      type: 'requestPipelineSave',
      pipeline: pipelineFixture('PL-2', [coderStep('st-1'), commandStep('st-2', 'true'), humanStep('st-3')]),
    });
    expect(changed.ok).toBe(true);
    const upsert = recorded.filter((frame) => frame.eventType === 'pipelineSaved').at(-1)!
      .body as { pipeline: { id: string; revision: number; steps: unknown[] } };
    expect(upsert.pipeline.id).toBe('PL-2');
    expect(upsert.pipeline.revision).toBe(2);
    expect(upsert.pipeline.steps).toHaveLength(3);
  });

  it('pipeline_save_keeps_every_revision_for_run_pinners', async () => {
    await savePipeline(projectId, pipelineFixture('PL-7', [coderStep('st-1')]));
    await savePipeline(projectId, pipelineFixture('PL-7', [coderStep('st-1'), commandStep('st-2', 'true')]));
    const project = bus.state.byProject.get(projectId)!;
    expect(project.pipelines.get('PL-7')?.steps).toHaveLength(2);
    expect(project.pipelines.get('PL-7')?.revision).toBe(2);
    expect(project.pipelineRevisions.get('PL-7')?.get(1)?.steps).toHaveLength(1);
    expect(project.pipelineRevisions.get('PL-7')?.get(2)?.steps).toHaveLength(2);
  });

  it('pipeline_save_validates_stages_and_the_forward_path', async () => {
    const cases: { pipeline: Pipeline; message: string }[] = [
      {
        pipeline: pipelineFixture('', [], [], 'no stages'),
        message: 'A pipeline needs at least one stage',
      },
      {
        pipeline: pipelineFixture('', []),
        message: 'A pipeline needs at least one step',
      },
      {
        pipeline: pipelineFixture('', [coderStep('st-1'), coderStep('st-1')]),
        message: "Step id 'st-1' appears twice",
      },
      {
        pipeline: pipelineFixture('', [{ id: 'st-1', kind: 'agent', stageId: 'p-x', agentKind: 'coder', instructions: 'x' }]),
        message: "Step 1: stage 'p-x' is not a stage of this pipeline",
      },
      {
        pipeline: pipelineFixture('', [commandStep('st-1', 'true'), coderStep('st-2')]),
        message: 'Step 2: the normal path must not move to an earlier stage',
      },
      {
        pipeline: pipelineFixture('', [coderStep('st-1')], defaultStages().map((stage) => ({ ...stage, kanbanVisible: false }))),
        message: 'The first stage must be Kanban-visible',
      },
      {
        pipeline: pipelineFixture('', [coderStep('st-1')], defaultStages().slice(0, 3)),
        message: 'A pipeline needs exactly one terminal (Done) stage',
      },
      {
        pipeline: pipelineFixture('', [coderStep('st-1')], [
          ...defaultStages().slice(0, 3),
          { id: STAGE_DONE, label: 'Done', kanbanVisible: true, terminal: true },
          { id: 'p-5', label: 'After', kanbanVisible: true },
        ]),
        message: 'The terminal stage must be the last stage',
      },
      {
        pipeline: pipelineFixture('', [coderStep('st-1')], [
          { id: STAGE_IMPLEMENT, label: 'Implementation', kanbanVisible: true, errorReturnToStageId: STAGE_CHECK },
          ...defaultStages().slice(1),
        ]),
        message: 'Stage 1: the error condition may only return to an earlier stage',
      },
      {
        pipeline: pipelineFixture('', [coderStep('st-1')], [
          { id: STAGE_IMPLEMENT, label: 'Implementation', kanbanVisible: true, outcomes: [{ outcome: 'rework', toStageId: STAGE_CHECK }] },
          ...defaultStages().slice(1),
        ]),
        message: "Stage 1: outcome 'rework' may only return to an earlier stage",
      },
    ];
    for (const case_ of cases) {
      const result = await processor.execute(projectId, {
        type: 'requestPipelineSave',
        pipeline: case_.pipeline,
      });
      expect(result).toEqual({ ok: false, rejection: { code: 'invalidCommand', message: case_.message } });
    }

    const blankName = await processor.execute(projectId, {
      type: 'requestPipelineSave',
      pipeline: { ...pipelineFixture('', [coderStep('st-1')]), name: '  ' },
    });
    expect(blankName).toEqual({
      ok: false,
      rejection: { code: 'invalidCommand', message: 'Pipeline name is required' },
    });
  });

  it('pipeline_delete_tombstones_and_rejects_assigned_cards', async () => {
    // The seeded default (PL-1) has no assigned cards yet: it deletes.
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

    // A pipeline with assigned cards rejects deletion.
    const cardId = await createCard(projectId);
    const deleteAssigned = await processor.execute(projectId, { type: 'requestPipelineDelete', pipelineId: 'PL-1' });
    expect(deleteAssigned).toEqual({
      ok: false,
      rejection: { code: 'invalidCommand', message: 'Pipeline PL-1 still has 1 assigned card' },
    });
    void cardId;

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

  it('run_pipeline_validates_card_directory_and_agent_kinds', async () => {
    const unknownCard = await processor.execute(projectId, {
      type: 'requestPipelineRun',
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
      card: { id: '', projectId: 'P-2', type: 'coding', title: 'x', description: '', tags: [], pipelineId: '', stageId: '', blockedBy: [], stepStates: {}, createdAt: '', updatedAt: '' },
    });
    const noDirectory = await processor.execute('P-2', { type: 'requestPipelineRun', cardId: 'T-1' });
    expect(noDirectory).toEqual({
      ok: false,
      rejection: { code: 'invalidCommand', message: 'Project P-2 has no directory set' },
    });

    // A pipeline whose agent step names an unknown kind rejects the run.
    const pipelineId = await savePipeline(projectId, pipelineFixture('PL-9', [{ ...coderStep('st-1'), agentKind: 'designer' }]));
    await processor.execute(projectId, { type: 'requestCardPipelineAssign', cardId, pipelineId });
    const unknownKind = await processor.execute(projectId, { type: 'requestPipelineRun', cardId });
    expect(unknownKind).toEqual({
      ok: false,
      rejection: { code: 'unknownAgentKind', message: "Agent kind 'designer' has no implementation yet" },
    });
  });

  it('a_run_allocates_a_record_pins_the_revision_and_walks_to_done', async () => {
    engine.enqueue(async ({ spec }) => {
      expect(spec.agentName).toBe('composer-coder');
      expect(spec.prompt).toContain(`Implement card ${cardId}`);
      return 'implemented the card';
    });
    // Save a new revision of the default after the card exists: the run
    // pins the revision current at start.
    const pipelineId = await savePipeline(projectId, pipelineFixture('PL-1', [
      coderStep('st-1'),
      commandStep('st-2', 'true'),
      humanStep('st-3'),
    ]));

    const started = await runOn(projectId, pipelineId, cardId);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.runId).toBe('R-1');

    // The gate parks the run waiting at the approval stage; the card sits there.
    await waitUntil(() => activeRunOf(projectId, cardId)?.status === 'waiting');
    const active = activeRunOf(projectId, cardId)!;
    expect(active.pipelineId).toBe('PL-1');
    expect(active.revision).toBe(2);
    expect(cardOf(projectId, cardId).stageId).toBe(STAGE_APPROVE);
    expect(cardOf(projectId, cardId).stepStates).toMatchObject({
      'st-1': 'ok',
      'st-2': 'ok',
      'st-3': 'running',
    });

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

    await waitUntil(() => cardOf(projectId, cardId).stageId === STAGE_DONE);
    expect(bus.state.byProject.get(projectId)?.activeRuns.has(cardId)).toBe(false);

    const ended = runEndedBody(projectId);
    expect(ended).toMatchObject({ runId: 'R-1', cardId, status: 'completed', revision: 2 });
    // Stream order: the terminal move rides after the run's end.
    const endIndex = recorded.findLastIndex((frame) => frame.eventType === 'pipelineRunEnded');
    expect(recorded[endIndex + 1]?.eventType).toBe('cardStageMoved');
    expect(recorded[endIndex + 1]?.body).toMatchObject({ cardId, toStageId: STAGE_DONE });
  });

  it('a_gate_rejection_returns_the_card_to_the_error_stage_and_ends_returned', async () => {
    engine.enqueue(async () => 'implemented');
    const pipelineId = await savePipeline(projectId, pipelineFixture('', [coderStep('st-1'), humanStep('st-2')]));
    await runOn(projectId, pipelineId, cardId);
    await waitUntil(() => activeRunOf(projectId, cardId)?.status === 'waiting');

    const rejected = await processor.execute(projectId, {
      type: 'requestPipelineGateRespond',
      cardId,
      approved: false,
      comment: 'needs tests',
    });
    expect(rejected.ok).toBe(true);

    await waitUntil(() => cardOf(projectId, cardId).stageId === STAGE_IMPLEMENT);
    expect(cardOf(projectId, cardId).rejectionComment).toBe('needs tests');
    const ended = runEndedBody(projectId);
    expect(ended.status).toBe('returned');
    expect(ended.error).toBe('changes requested: needs tests');
  });

  it('the_run_executes_from_the_cards_current_stage_onward', async () => {
    const pipelineId = await savePipeline(projectId, pipelineFixture('', [
      coderStep('st-1'),
      commandStep('st-2', 'exit 0'),
      humanStep('st-3'),
    ]));
    // Assign the card to the pipeline, then move it to Validation: the
    // implementation step is skipped by the run.
    await processor.execute(projectId, { type: 'requestCardPipelineAssign', cardId, pipelineId });
    const moved = await processor.execute(projectId, {
      type: 'requestCardStageMove',
      cardId,
      toStageId: STAGE_CHECK,
      override: false,
    });
    expect(moved.ok).toBe(true);
    const started = await processor.execute(projectId, { type: 'requestPipelineRun', cardId });
    expect(started.ok).toBe(true);

    await waitUntil(() => activeRunOf(projectId, cardId)?.status === 'waiting');
    await processor.execute(projectId, { type: 'requestPipelineGateRespond', cardId, approved: true });
    await waitUntil(() => cardOf(projectId, cardId).stageId === STAGE_DONE);
    const startedSteps = recorded
      .filter((frame) => frame.eventType === 'pipelineStepStarted')
      .map((frame) => (frame.body as { stepId: string }).stepId);
    expect(startedSteps).toEqual(['st-2', 'st-3'], 'the implementation step was skipped');
  });

  it('the_workers_walk_their_stages_and_the_sessions_name_their_kinds', async () => {
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
    const workerStep = (id: string, agentKind: string, stageId: string): PipelineStep => ({
      id,
      kind: 'agent',
      stageId,
      agentKind,
      instructions: 'Do your part.',
    });
    const stages: PipelineStage[] = [
      { id: 'w-1', label: 'Implementation', kanbanVisible: true },
      { id: 'w-2', label: 'Validation', kanbanVisible: true },
      { id: 'w-3', label: 'Review', kanbanVisible: true },
      { id: 'w-4', label: 'Security', kanbanVisible: true },
      { id: 'w-5', label: 'Approval', kanbanVisible: true, errorReturnToStageId: 'w-1' },
      { id: 'w-6', label: 'Done', kanbanVisible: true, terminal: true },
    ];
    const pipelineId = await savePipeline(projectId, pipelineFixture('', [
      coderStep('st-1', 'w-1'),
      workerStep('st-2', 'tester', 'w-2'),
      workerStep('st-3', 'reviewer', 'w-3'),
      workerStep('st-4', 'security', 'w-4'),
      humanStep('st-5', 'w-5'),
    ], stages));
    const started = await runOn(projectId, pipelineId, cardId);
    expect(started.ok).toBe(true);

    await waitUntil(() => activeRunOf(projectId, cardId)?.status === 'waiting');
    expect(cardOf(projectId, cardId).stageId).toBe('w-5');
    expect(cardOf(projectId, cardId).stepStates).toMatchObject({
      'st-1': 'ok',
      'st-2': 'ok',
      'st-3': 'ok',
      'st-4': 'ok',
      'st-5': 'running',
    });

    // Each step's session names its kind on the wire (ids allocate A-N in
    // walk order) — what the desktop's session list folds.
    const startedKinds = recorded
      .filter((frame) => frame.eventType === 'agentSessionStarted')
      .map((frame) => (frame.body as { agentKind: string }).agentKind);
    expect(startedKinds).toEqual(['coder', 'tester', 'reviewer', 'security']);

    await processor.execute(projectId, { type: 'requestPipelineGateRespond', cardId, approved: true });
    await waitUntil(() => cardOf(projectId, cardId).stageId === 'w-6');
  });

  it('a_failed_command_step_returns_the_card_when_the_stage_configures_it', async () => {
    // The Validation stage carries the error return: the failed command
    // moves the card back to Implementation and ends the run `returned`.
    const stages = defaultStages().map((stage) =>
      stage.id === STAGE_CHECK ? { ...stage, errorReturnToStageId: STAGE_IMPLEMENT } : stage,
    );
    const pipelineId = await savePipeline(
      projectId,
      pipelineFixture('', [commandStep('st-1', 'echo boom >&2; false')], stages),
    );
    const started = await runOn(projectId, pipelineId, cardId);
    expect(started.ok).toBe(true);

    await waitUntil(() => !bus.state.byProject.get(projectId)?.activeRuns.has(cardId));
    expect(cardOf(projectId, cardId).stageId).toBe(STAGE_IMPLEMENT, 'the stage error return moved the card back');
    expect(cardOf(projectId, cardId).stepStates['st-1']).toBe('failed');
    const ended = runEndedBody(projectId);
    expect(ended.status).toBe('returned');
    expect(ended.error).toContain('exit code 1');
    expect(ended.error).toContain('boom');

    // Re-run is the recovery story (D5): the same run command works again.
    const again = await processor.execute(projectId, { type: 'requestPipelineRun', cardId });
    expect(again.ok).toBe(true);
  });

  it('a_failed_step_without_an_error_condition_fails_in_place', async () => {
    const stages = defaultStages().map((stage) =>
      stage.id === STAGE_CHECK ? { ...stage, errorReturnToStageId: undefined } : stage,
    );
    const pipelineId = await savePipeline(
      projectId,
      pipelineFixture('', [commandStep('st-1', 'echo boom >&2; false')], stages),
    );
    await runOn(projectId, pipelineId, cardId);
    await waitUntil(() => !bus.state.byProject.get(projectId)?.activeRuns.has(cardId));
    expect(cardOf(projectId, cardId).stageId).toBe(STAGE_CHECK, 'the card stays where it failed');
    const ended = runEndedBody(projectId);
    expect(ended.status).toBe('failed');
  });

  it('an_outcome_report_returns_the_card_and_ends_the_run_returned', async () => {
    const stages = defaultStages().map((stage) =>
      stage.id === STAGE_APPROVE
        ? {
            ...stage,
            outcomes: [{ outcome: 'approved' }, { outcome: 'changes_requested', toStageId: STAGE_IMPLEMENT }],
            requiresOutcome: true,
          }
        : stage,
    );
    const pipelineId = await savePipeline(projectId, pipelineFixture('', [coderStep('st-1', STAGE_APPROVE)], stages));
    engine.enqueue(async ({ spec }) => {
      // The brief teaches the outcome vocabulary and the required call.
      expect(spec.prompt).toContain('composer_report_outcome');
      expect(spec.prompt).toContain('changes_requested');
      expect(spec.prompt).toContain('returns to Implementation');
      expect(spec.prompt).toContain('requires the call');
      const reported = await processor.execute(projectId, {
        type: 'requestPipelineOutcomeReport',
        sessionId: spec.sessionId,
        outcome: 'changes_requested',
        note: 'the error path is untested',
      });
      expect(reported).toMatchObject({
        ok: true,
        transition: 'the card returns to Implementation when the step finishes',
      });
      return 'asked for changes';
    });
    const started = await runOn(projectId, pipelineId, cardId);
    expect(started.ok).toBe(true);

    await waitUntil(() => !bus.state.byProject.get(projectId)?.activeRuns.has(cardId));
    expect(cardOf(projectId, cardId).stageId).toBe(STAGE_IMPLEMENT, 'the outcome rule moved the card back');
    expect(cardOf(projectId, cardId).rejectionComment).toBe('the error path is untested');
    expect(cardOf(projectId, cardId).stepStates['st-1']).toBe('ok', 'the agent turn itself succeeded');
    expect(recorded.findLast((frame) => frame.eventType === 'pipelineOutcomeReported')?.body).toMatchObject({
      stepId: 'st-1',
      outcome: 'changes_requested',
      note: 'the error path is untested',
    });
    const ended = runEndedBody(projectId);
    expect(ended.status).toBe('returned');
    expect(ended.error).toBe('changes_requested: the error path is untested');

    // The returned card re-runs from where it sits (the stage skip).
    const again = await processor.execute(projectId, { type: 'requestPipelineRun', cardId });
    expect(again.ok).toBe(true);
  });

  it('a_forward_outcome_proceeds_and_the_walk_completes', async () => {
    const stages = defaultStages().map((stage) =>
      stage.id === STAGE_CHECK ? { ...stage, outcomes: [{ outcome: 'pass' }], requiresOutcome: true } : stage,
    );
    const pipelineId = await savePipeline(
      projectId,
      pipelineFixture('', [coderStep('st-1', STAGE_CHECK), commandStep('st-2', 'true', STAGE_APPROVE)], stages),
    );
    engine.enqueue(async ({ spec }) => {
      const reported = await processor.execute(projectId, {
        type: 'requestPipelineOutcomeReport',
        sessionId: spec.sessionId,
        outcome: 'pass',
      });
      expect(reported).toMatchObject({ ok: true, transition: 'the pipeline proceeds when the step finishes' });
      return 'verified';
    });
    await runOn(projectId, pipelineId, cardId);
    await waitUntil(() => cardOf(projectId, cardId).stageId === STAGE_DONE);
    expect(runEndedBody(projectId)).toMatchObject({ status: 'completed' });
    expect(cardOf(projectId, cardId).stepStates).toMatchObject({ 'st-1': 'ok', 'st-2': 'ok' });
  });

  it('requiresOutcome_fails_a_turn_that_reported_nothing', async () => {
    const stages = defaultStages().map((stage) =>
      stage.id === STAGE_CHECK
        ? { ...stage, outcomes: [{ outcome: 'pass' }], requiresOutcome: true, errorReturnToStageId: STAGE_IMPLEMENT }
        : stage,
    );
    const pipelineId = await savePipeline(projectId, pipelineFixture('', [coderStep('st-1', STAGE_CHECK)], stages));
    engine.enqueue(async () => 'done, trust me');
    await runOn(projectId, pipelineId, cardId);
    await waitUntil(() => !bus.state.byProject.get(projectId)?.activeRuns.has(cardId));
    expect(cardOf(projectId, cardId).stepStates['st-1']).toBe('failed');
    expect(cardOf(projectId, cardId).stageId).toBe(STAGE_IMPLEMENT, 'the failure flows through the stage error return');
    const ended = runEndedBody(projectId);
    expect(ended.status).toBe('returned');
    expect(ended.error).toContain('requires an explicit outcome');
    expect(ended.error).toContain('pass');
  });

  it('a_report_on_a_stage_without_outcomes_rejects_and_the_turn_still_proceeds', async () => {
    const pipelineId = await savePipeline(
      projectId,
      pipelineFixture('', [coderStep('st-1', STAGE_CHECK), commandStep('st-2', 'true', STAGE_APPROVE)]),
    );
    engine.enqueue(async ({ spec }) => {
      const reported = await processor.execute(projectId, {
        type: 'requestPipelineOutcomeReport',
        sessionId: spec.sessionId,
        outcome: 'pass',
      });
      expect(reported).toEqual({
        ok: false,
        rejection: { code: 'invalidCommand', message: 'Stage Validation defines no outcomes to report' },
      });
      return 'done';
    });
    await runOn(projectId, pipelineId, cardId);
    await waitUntil(() => cardOf(projectId, cardId).stageId === STAGE_DONE);
    expect(runEndedBody(projectId)).toMatchObject({ status: 'completed' });
  });

  it('stop_ends_the_run_cancelled_and_kills_the_child', async () => {
    const pipelineId = await savePipeline(projectId, pipelineFixture('', [commandStep('st-1', 'sleep 30')]));
    await runOn(projectId, pipelineId, cardId);
    await waitUntil(() => cardOf(projectId, cardId).stepStates['st-1'] === 'running');

    const stopped = await processor.execute(projectId, { type: 'requestPipelineStop', cardId });
    expect(stopped.ok).toBe(true);

    await waitUntil(() => !bus.state.byProject.get(projectId)?.activeRuns.has(cardId));
    // The card keeps its last position; nothing publishes after the cancel.
    expect(cardOf(projectId, cardId).stageId).toBe(STAGE_CHECK);
    const endCount = recorded.filter((frame) => frame.eventType === 'pipelineRunEnded').length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(recorded.filter((frame) => frame.eventType === 'pipelineRunEnded')).toHaveLength(endCount);
    expect(runEndedBody(projectId)).toMatchObject({ status: 'cancelled' });

    const notRunning = await processor.execute(projectId, { type: 'requestPipelineStop', cardId });
    expect(notRunning).toEqual({
      ok: false,
      rejection: { code: 'pipelineNotRunning', message: `Card ${cardId} has no running pipeline` },
    });
  });

  it('boot_cancels_interrupted_runs', async () => {
    // A run interrupted mid-step: the fold holds the progress.
    await bus.publish(projectId, 'pipelineRunStarted', { runId: 'R-1', cardId, pipelineId: 'PL-1', revision: 1 });
    await bus.publish(projectId, 'pipelineStepStarted', {
      runId: 'R-1',
      cardId,
      pipelineId: 'PL-1',
      stepId: 'st-1',
      kind: 'agent',
      stageId: 'sg-2',
    });
    expect(bus.state.byProject.get(projectId)?.runs.get('R-1')?.status).toBe('running');

    const cancelled = await cancelInterruptedRuns(bus);
    expect(cancelled).toBe(1);
    expect(bus.state.byProject.get(projectId)?.runs.get('R-1')?.status).toBe('cancelled');
  });

  it('terminal_run_health_survives_a_snapshot', async () => {
    runner.stop();
    await bus.publish(projectId, 'pipelineRunStarted', { runId: 'R-1', cardId, pipelineId: 'PL-1', revision: 1 });
    await bus.publish(projectId, 'pipelineRunEnded', {
      runId: 'R-1',
      cardId,
      pipelineId: 'PL-1',
      revision: 1,
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

    const before = bus.state.byProject.get(projectId)?.runs.get('R-1');
    expect(replayed.byProject.get(projectId)?.runs.get('R-1')).toEqual(before);
  });

  it('the_pipeline_snapshot_replays_into_equal_state', async () => {
    engine.enqueue(async () => 'implemented');
    const pipelineId = await savePipeline(projectId, pipelineFixture('', [coderStep('st-1'), humanStep('st-2')]));
    await runOn(projectId, pipelineId, cardId);
    await waitUntil(() => activeRunOf(projectId, cardId)?.status === 'waiting');
    await savePipeline(projectId, pipelineFixture('PL-5', [commandStep('st-1', 'true')]));

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
      pipelineRevisions: [...project.pipelineRevisions.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, revisions]) => [id, [...revisions.entries()].sort(([a], [b]) => a - b)]),
      deletedPipelines: [...project.deletedPipelines].sort(),
      runs: [...project.runs.entries()].sort(([a], [b]) => a.localeCompare(b)),
      activeRuns: [...project.activeRuns.entries()].sort(([a], [b]) => a.localeCompare(b)),
      automation: [...project.automation.entries()],
    }));
  }
});

describe('the outcome report command', () => {
  let projectId: string;
  let cardId: string;

  beforeEach(async () => {
    projectId = await createProject();
    cardId = await createCard(projectId);
  });

  const startedAt = () => new Date().toISOString();

  it('validates_the_session_run_and_step_kind', async () => {
    const unknownSession = await processor.execute(projectId, {
      type: 'requestPipelineOutcomeReport',
      sessionId: 'A-9',
      outcome: 'approved',
    });
    expect(unknownSession).toEqual({
      ok: false,
      rejection: { code: 'unknownSession', message: 'Unknown session A-9' },
    });

    // A live session whose card has no run.
    await bus.publish(projectId, 'agentSessionStarted', { cardId, sessionId: 'A-1', agentKind: 'coder', startedAt: startedAt() });
    const noRun = await processor.execute(projectId, {
      type: 'requestPipelineOutcomeReport',
      sessionId: 'A-1',
      outcome: 'approved',
    });
    expect(noRun).toEqual({
      ok: false,
      rejection: { code: 'pipelineNotRunning', message: `Card ${cardId} has no running pipeline` },
    });

    // Parked at a command step: reporting needs an agent step.
    await bus.publish(projectId, 'pipelineRunStarted', { runId: 'R-1', cardId, pipelineId: 'PL-1', revision: 1 });
    await bus.publish(projectId, 'pipelineStepStarted', {
      runId: 'R-1',
      cardId,
      pipelineId: 'PL-1',
      stepId: 'st-2',
      kind: 'command',
      stageId: 'sg-3',
    });
    const notAgent = await processor.execute(projectId, {
      type: 'requestPipelineOutcomeReport',
      sessionId: 'A-1',
      outcome: 'approved',
    });
    expect(notAgent).toEqual({
      ok: false,
      rejection: { code: 'invalidCommand', message: `Card ${cardId}'s pipeline is not at an agent step` },
    });

    // An ended session cannot report (its turn is over).
    await bus.publish(projectId, 'pipelineStepStarted', {
      runId: 'R-1',
      cardId,
      pipelineId: 'PL-1',
      stepId: 'st-4',
      kind: 'agent',
      stageId: 'sg-4',
    });
    await bus.publish(projectId, 'agentSessionEnded', { cardId, sessionId: 'A-1', status: 'ended', endedAt: startedAt() });
    const endedSession = await processor.execute(projectId, {
      type: 'requestPipelineOutcomeReport',
      sessionId: 'A-1',
      outcome: 'approved',
    });
    expect(endedSession).toEqual({
      ok: false,
      rejection: { code: 'invalidCommand', message: 'Session A-1 is not running' },
    });
  });

  it('validates_the_name_against_the_stage_rules_and_the_pinned_revision', async () => {
    // Revision 1 of PL-4 carries the outcome rule; revision 2 drops it.
    const v1 = defaultStages().map((stage) =>
      stage.id === STAGE_CHECK ? { ...stage, outcomes: [{ outcome: 'pass' }] } : stage,
    );
    await savePipeline(projectId, pipelineFixture('PL-4', [coderStep('st-1', STAGE_CHECK)], v1));
    await savePipeline(projectId, pipelineFixture('PL-4', [coderStep('st-1', STAGE_CHECK)]));

    await bus.publish(projectId, 'pipelineRunStarted', { runId: 'R-1', cardId, pipelineId: 'PL-4', revision: 1 });
    await bus.publish(projectId, 'agentSessionStarted', { cardId, sessionId: 'A-1', agentKind: 'coder', startedAt: startedAt() });
    await bus.publish(projectId, 'pipelineStepStarted', {
      runId: 'R-1',
      cardId,
      pipelineId: 'PL-4',
      stepId: 'st-1',
      kind: 'agent',
      stageId: STAGE_CHECK,
    });

    // The report reads the run's pinned revision, where the rule exists.
    const ok = await processor.execute(projectId, {
      type: 'requestPipelineOutcomeReport',
      sessionId: 'A-1',
      outcome: 'pass',
    });
    if (!ok.ok) throw new Error(ok.rejection.message);
    expect(ok.transition).toBe('the pipeline proceeds when the step finishes');

    const disallowed = await processor.execute(projectId, {
      type: 'requestPipelineOutcomeReport',
      sessionId: 'A-1',
      outcome: 'rework',
    });
    expect(disallowed).toEqual({
      ok: false,
      rejection: {
        code: 'invalidCommand',
        message: "outcome 'rework' is not one of stage Validation's outcomes: 'pass'",
      },
    });

    // A run pinned to revision 2 — where the rule is gone — rejects.
    await bus.publish(projectId, 'pipelineRunEnded', { runId: 'R-1', cardId, pipelineId: 'PL-4', revision: 1, status: 'cancelled' });
    await bus.publish(projectId, 'pipelineRunStarted', { runId: 'R-2', cardId, pipelineId: 'PL-4', revision: 2 });
    await bus.publish(projectId, 'pipelineStepStarted', {
      runId: 'R-2',
      cardId,
      pipelineId: 'PL-4',
      stepId: 'st-1',
      kind: 'agent',
      stageId: STAGE_CHECK,
    });
    const gone = await processor.execute(projectId, {
      type: 'requestPipelineOutcomeReport',
      sessionId: 'A-1',
      outcome: 'pass',
    });
    expect(gone).toEqual({
      ok: false,
      rejection: { code: 'invalidCommand', message: 'Stage Validation defines no outcomes to report' },
    });
  });
});
