// The project and card domains: validation order, rejection messages, and
// the emitted events. Phase 10: cards carry a pipeline assignment and a
// pipeline-local step; moves are step moves; runs lock the card. The fold
// and the snapshot round-trip into equal state.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Bus } from '../src/bus.js';
import { Processor } from '../src/processor/index.js';
import { apply } from '../src/fold/index.js';
import { snapshotEvents } from '../src/snapshot.js';
import { newState, type State } from '../src/fold/index.js';
import { type Card, type CardType, type Pipeline } from '../src/wire/models.js';
import type { EventFrame } from '../src/wire/envelope.js';

let dir: string;
let store: InstanceType<typeof import('../src/store/index.js').EventStore>;
let bus: Bus;
let processor: Processor;
const recorded: EventFrame[] = [];

beforeEach(async () => {
  recorded.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'composer-proc-'));
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

const ProjectCreated = 'projectCreated' as const;

/** A blank card the way the action mapper builds one (ids unset; the processor assigns). */
function blankCard(projectId: string, type: CardType, title: string, blockedBy: string[] = []): Card {
  return {
    id: '',
    projectId,
    type,
    title,
    description: '',
    tags: [],
    pipelineId: '',
    stepId: '',
    blockedBy,
    stepStates: {},
    createdAt: '',
    updatedAt: '',
  };
}

/**
 * The seeded default pipeline's steps:
 * coder → build → test → review → approval → done.
 */
const STEPS = ['st-1', 'st-2', 'st-3', 'st-4', 'st-5', 'st-6'] as const;
const FIRST = 'st-1';
const DONE = 'st-6';

function pipelineOf(projectId: string, pipelineId = 'PL-1'): Pipeline {
  const pipeline = bus.state.byProject.get(projectId)?.pipelines.get(pipelineId);
  if (!pipeline) throw new Error(`pipeline ${pipelineId} not in state`);
  return pipeline;
}

describe('project commands', () => {
  it('create_project_rejects_empty_and_duplicate_names', async () => {
    const empty = await processor.execute(undefined, {
      type: 'requestProjectCreate',
      name: '  ',
    });
    expect(empty).toEqual({
      ok: false,
      rejection: { code: 'invalidCommand', message: 'Project name is required' },
    });

    const created = await processor.execute(undefined, {
      type: 'requestProjectCreate',
      name: 'alpha',
    });
    expect(created.ok).toBe(true);

    const duplicate = await processor.execute(undefined, {
      type: 'requestProjectCreate',
      name: 'ALPHA',
    });
    expect(duplicate).toEqual({
      ok: false,
      rejection: { code: 'invalidCommand', message: "Project 'ALPHA' already exists" },
    });
  });

  it('create_project_emits_created_then_activated_then_the_staged_default_pipeline', async () => {
    await processor.execute(undefined, { type: 'requestProjectCreate', name: 'alpha' });
    expect(recorded.map((frame) => frame.eventType)).toEqual([
      ProjectCreated,
      'projectActivated',
      'pipelineSaved',
    ]);
    const project = (recorded[0]?.body as { project: { id: string } }).project;
    expect(project.id).toBe('P-1');
    const pipeline = (recorded[2]?.body as { pipeline: Pipeline }).pipeline;
    expect(pipeline.id).toBe('PL-1');
    expect(pipeline.revision).toBe(1);
    expect(pipeline.steps.map((step) => step.id)).toEqual([...STEPS]);
    expect(pipeline.steps[0]?.boardVisible).toBe(true);
    expect(pipeline.steps.at(-1)?.terminal).toBe(true);
    // The Review step carries the shipped outcome rules (S36).
    expect(pipeline.steps[3]?.outcomes).toEqual([
      { outcome: 'approved' },
      { outcome: 'changes_requested', toStepId: 'st-1' },
    ]);
    expect(pipeline.steps[3]?.requiresOutcome).toBe(true);
    expect(pipeline.steps.map((step) => step.kind)).toEqual(['agent', 'command', 'command', 'agent', 'human', 'human']);
    expect(pipeline.steps[3]?.agentKind).toBe('reviewer');
  });

  it('create_project_validates_and_links_the_directory', async () => {
    const missing = await processor.execute(undefined, {
      type: 'requestProjectCreate',
      name: 'alpha',
      directory: '/composer/does/not/exist',
    });
    expect(missing).toEqual({
      ok: false,
      rejection: { code: 'invalidCommand', message: 'Project directory must exist' },
    });

    const linked = await processor.execute(undefined, {
      type: 'requestProjectCreate',
      name: 'alpha',
      directory: dir,
    });
    expect(linked.ok).toBe(true);

    const again = await processor.execute(undefined, {
      type: 'requestProjectCreate',
      name: 'beta',
      directory: `${dir}/`,
    });
    expect(again).toEqual({
      ok: false,
      rejection: { code: 'invalidCommand', message: `Directory '${dir}' is already linked` },
    });
  });

  it('set_project_directory_validates_and_updates', async () => {
    await processor.execute(undefined, { type: 'requestProjectCreate', name: 'alpha' });
    const other = mkdtempSync(join(tmpdir(), 'composer-dir-'));

    const noScope = await processor.execute('P-9', {
      type: 'requestProjectSetDirectory',
      projectId: 'P-1',
      directory: other,
    });
    expect(noScope).toEqual({
      ok: false,
      rejection: { code: 'unknownProject', message: 'Unknown project P-9' },
    });

    const updated = await processor.execute('P-1', {
      type: 'requestProjectSetDirectory',
      projectId: 'P-1',
      directory: other,
    });
    expect(updated.ok).toBe(true);
    expect(bus.state.projects.get('P-1')?.directory).toBe(other);

    // Same directory: a no-op (no event).
    const before = recorded.length;
    const same = await processor.execute('P-1', {
      type: 'requestProjectSetDirectory',
      projectId: 'P-1',
      directory: other,
    });
    expect(same.ok).toBe(true);
    expect(recorded.length).toBe(before);
    rmSync(other, { recursive: true, force: true });
  });

  it('activate_project_rejects_unknown_projects', async () => {
    const result = await processor.execute(undefined, {
      type: 'requestProjectActivate',
      projectId: 'P-9',
    });
    expect(result).toEqual({
      ok: false,
      rejection: { code: 'unknownProject', message: 'Unknown project P-9' },
    });
  });

  it('archives_and_restores_a_project_without_removing_its_state', async () => {
    await processor.execute(undefined, { type: 'requestProjectCreate', name: 'alpha' });
    await processor.execute('P-1', {
      type: 'requestCardCreate',
      card: blankCard('P-1', 'coding', 'kept'),
    });

    const archived = await processor.execute('P-1', {
      type: 'requestProjectArchive',
      projectId: 'P-1',
    });

    expect(archived).toEqual({ ok: true });
    expect(bus.state.projects.get('P-1')?.archivedAt).toBeTruthy();
    expect(bus.state.byProject.get('P-1')?.cards.has('T-1')).toBe(true);
    expect(recorded.at(-1)?.eventType).toBe('projectArchived');

    const mutation = await processor.execute('P-1', {
      type: 'requestCardCreate',
      card: blankCard('P-1', 'coding', 'hidden mutation'),
    });
    expect(mutation).toEqual({
      ok: false,
      rejection: { code: 'invalidCommand', message: 'Project P-1 is archived' },
    });

    const restored = await processor.execute('P-1', {
      type: 'requestProjectRestore',
      projectId: 'P-1',
    });
    expect(restored).toEqual({ ok: true });
    expect(bus.state.projects.get('P-1')?.archivedAt).toBeUndefined();
    expect(bus.state.byProject.get('P-1')?.cards.has('T-1')).toBe(true);
    expect(recorded.at(-1)?.eventType).toBe('projectRestored');
  });

  it('refuses_to_archive_a_project_with_an_active_pipeline_run', async () => {
    await processor.execute(undefined, { type: 'requestProjectCreate', name: 'alpha' });
    await bus.publish('P-1', 'pipelineRunStarted', {
      runId: 'R-1',
      cardId: 'T-1',
      pipelineId: 'PL-1',
      revision: 1,
    });

    const result = await processor.execute('P-1', {
      type: 'requestProjectArchive',
      projectId: 'P-1',
    });

    expect(result).toEqual({
      ok: false,
      rejection: { code: 'invalidCommand', message: 'Project P-1 has an active pipeline run' },
    });
    expect(bus.state.projects.get('P-1')?.archivedAt).toBeUndefined();
  });

  it('the_snapshot_replays_into_equal_state', async () => {
    await processor.execute(undefined, { type: 'requestProjectCreate', name: 'alpha' });
    await processor.execute(undefined, { type: 'requestProjectCreate', name: 'beta', directory: dir });
    await processor.execute('P-2', { type: 'requestProjectArchive', projectId: 'P-2' });

    const snapshot = snapshotEvents(bus.state);
    const replayed = newState();
    for (const frame of snapshot) {
      apply(replayed, {
        id: frame.id,
        ...(frame.projectId !== undefined ? { projectId: frame.projectId } : {}),
        occurredAt: frame.occurredAt,
        name: frame.eventType,
        body: frame.body,
      });
    }
    expect([...replayed.projects.values()].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [...bus.state.projects.values()].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});

describe('card commands', () => {
  let projectId: string;

  beforeEach(async () => {
    const created = await processor.execute(undefined, { type: 'requestProjectCreate', name: 'alpha' });
    if (!created.ok) throw new Error(created.rejection.message);
    projectId = 'P-1';
  });

  async function createCard(
    title: string,
    type: CardType,
    blockedBy: string[] = [],
    scope: string = projectId,
  ): Promise<string> {
    const result = await processor.execute(scope, {
      type: 'requestCardCreate',
      card: blankCard(scope, type, title, blockedBy),
    });
    if (!result.ok) throw new Error(result.rejection.message);
    const events = recorded.filter((frame) => frame.eventType === 'cardCreated');
    return (events[events.length - 1]!.body as { card: { id: string } }).card.id;
  }

  function card(id: string): Card {
    const card = bus.state.byProject.get(projectId)?.cards.get(id);
    if (!card) throw new Error(`card ${id} not in state`);
    return card;
  }

  function move(cardId: string, toStepId: string, override = false, comment?: string) {
    return processor.execute(projectId, {
      type: 'requestCardStepMove',
      cardId,
      toStepId,
      override,
      ...(comment !== undefined ? { comment } : {}),
    });
  }

  it('card_create_assigns_sequential_ids_the_default_pipeline_and_the_first_step', async () => {
    const first = await createCard('one', 'coding');
    const second = await createCard('two', 'coding');
    expect(first).toBe('T-1');
    expect(second).toBe('T-2');
    expect(card(first).pipelineId).toBe('PL-1');
    expect(card(first).stepId).toBe(FIRST);
    expect(card(first).stepStates).toEqual({});
  });

  it('card_create_rejects_unknown_scope_unknown_blockers_and_unknown_pipelines', async () => {
    const noScope = await processor.execute(undefined, {
      type: 'requestCardCreate',
      card: blankCard('nope', 'coding', 'x'),
    });
    expect(noScope).toEqual({
      ok: false,
      rejection: { code: 'unknownProject', message: 'Unknown project ' },
    });

    const badDeps = await processor.execute(projectId, {
      type: 'requestCardCreate',
      card: blankCard(projectId, 'coding', 'x', ['T-99']),
    });
    expect(badDeps).toEqual({
      ok: false,
      rejection: { code: 'invalidCommand', message: "blockedBy of 'x' references unknown cards" },
    });

    const badPipeline = await processor.execute(projectId, {
      type: 'requestCardCreate',
      card: { ...blankCard(projectId, 'coding', 'x'), pipelineId: 'PL-99' },
    });
    expect(badPipeline).toEqual({
      ok: false,
      rejection: { code: 'unknownPipeline', message: 'Unknown pipeline PL-99' },
    });
  });

  it('blocked_card_emits_dependency_state_changed', async () => {
    const blocker = await createCard('blocker', 'coding');
    await createCard('blocked', 'coding', [blocker]);
    const dep = recorded.filter((frame) => frame.eventType === 'dependencyStateChanged')[0];
    expect(dep?.body).toEqual({ cardId: 'T-2', blocked: true, blockedBy: [blocker] });
  });

  it('step_move_validates_the_step_and_blockers', async () => {
    const blocker = await createCard('blocker', 'coding');
    const blocked = await createCard('blocked', 'coding', [blocker]);
    const rejectedMove = await move(blocked, 'st-2', false);
    expect(rejectedMove).toEqual({
      ok: false,
      rejection: { code: 'blocked', message: `Card ${blocked} has unsatisfied blockers` },
    });

    const forced = await move(blocked, 'st-2', true);
    expect(forced).toEqual({ ok: true });
    expect(card(blocked).stepId).toBe('st-2');

    const unknownStep = await move(blocked, 'st-99');
    expect(unknownStep).toEqual({
      ok: false,
      rejection: { code: 'unknownStep', message: "Step 'st-99' is not a step of pipeline PL-1" },
    });
  });

  it('step_move_rejects_unknown_cards_and_no_ops_on_the_same_step', async () => {
    const unknown = await move('T-99', 'st-2');
    expect(unknown).toEqual({
      ok: false,
      rejection: { code: 'unknownCard', message: 'Unknown card T-99' },
    });

    const id = await createCard('still new', 'coding');
    const before = recorded.length;
    const noOp = await move(id, FIRST);
    expect(noOp).toEqual({ ok: true });
    expect(recorded.length).toBe(before);
  });

  it('step_move_rejects_while_a_run_is_active', async () => {
    const id = await createCard('busy', 'coding');
    await bus.publish(projectId, 'pipelineRunStarted', {
      runId: 'R-1',
      cardId: id,
      pipelineId: 'PL-1',
      revision: 1,
    });
    const locked = await move(id, 'st-2');
    expect(locked).toEqual({
      ok: false,
      rejection: { code: 'runActive', message: `Card ${id} has an active pipeline run` },
    });
    await bus.publish(projectId, 'pipelineRunEnded', {
      runId: 'R-1',
      cardId: id,
      pipelineId: 'PL-1',
      revision: 1,
      status: 'cancelled',
    });
    expect((await move(id, 'st-2')).ok).toBe(true);
  });

  it('the_move_comment_records_the_rejection_comment', async () => {
    const id = await createCard('rejected', 'coding');
    await move(id, 'st-2');
    await move(id, 'st-4');
    await move(id, 'st-2', false, 'needs tests');
    expect(card(id).rejectionComment).toBe('needs tests');
  });

  it('blocker_reaching_the_terminal_step_unblocks_dependents', async () => {
    const blocker = await createCard('blocker', 'coding');
    const blocked = await createCard('blocked', 'coding', [blocker]);
    expect(card(blocked).blockedBy.some((id) => card(id).stepId !== DONE)).toBe(true);

    await move(blocker, 'st-2');
    await move(blocker, DONE);
    const deps = recorded
      .filter((frame) => frame.eventType === 'dependencyStateChanged')
      .map((frame) => frame.body as { cardId: string; blocked: boolean })
      .filter((body) => body.cardId === blocked);
    expect(deps.at(-1)?.blocked).toBe(false);
  });

  it('pipeline_assign_places_the_card_in_the_first_step', async () => {
    const id = await createCard('traveller', 'coding');
    await move(id, 'st-3');

    const unknown = await processor.execute(projectId, {
      type: 'requestCardPipelineAssign',
      cardId: id,
      pipelineId: 'PL-99',
    });
    expect(unknown).toEqual({
      ok: false,
      rejection: { code: 'unknownPipeline', message: 'Unknown pipeline PL-99' },
    });

    // Save a second pipeline to reassign to.
    const saved = await processor.execute(projectId, {
      type: 'requestPipelineSave',
      pipeline: {
        id: '',
        projectId,
        name: 'Docs pass',
        revision: 0,
        steps: [
          { id: 'd-1', kind: 'agent', boardVisible: true, agentKind: 'coder', instructions: 'Write.' },
          { id: 'd-2', kind: 'human', boardVisible: true, terminal: true },
        ],
        updatedAt: '',
      },
    });
    expect(saved.ok).toBe(true);

    const assigned = await processor.execute(projectId, {
      type: 'requestCardPipelineAssign',
      cardId: id,
      pipelineId: 'PL-2',
    });
    expect(assigned.ok).toBe(true);
    expect(recorded.at(-1)?.eventType).toBe('cardPipelineAssigned');
    expect(card(id).pipelineId).toBe('PL-2');
    expect(card(id).stepId).toBe('d-1');
  });

  it('reopen_returns_a_completed_card_to_the_first_step', async () => {
    const id = await createCard('finished', 'coding');
    await move(id, DONE);

    const notCompleted = await processor.execute(projectId, {
      type: 'requestCardReopen',
      cardId: (await createCard('running', 'coding')),
    });
    expect(notCompleted).toEqual({
      ok: false,
      rejection: { code: 'invalidCommand', message: 'Card T-2 is not completed' },
    });

    const result = await processor.execute(projectId, { type: 'requestCardReopen', cardId: id });
    expect(result.ok).toBe(true);
    expect(card(id).stepId).toBe(FIRST);
  });

  it('type_change_resets_step_states_and_keeps_the_step', async () => {
    const id = await createCard('switching', 'coding');
    await move(id, 'st-3');
    await processor.execute(projectId, {
      type: 'requestStepStateUpdate',
      cardId: id,
      stepId: 'st-1',
      status: 'ok',
    });

    const result = await processor.execute(projectId, {
      type: 'requestCardTypeChange',
      cardId: id,
      toType: 'design',
    });
    expect(result.ok).toBe(true);
    const changed = recorded.filter((frame) => frame.eventType === 'cardTypeChanged')[0];
    expect(changed?.body).toMatchObject({ cardId: id, from: 'coding' });

    expect(card(id).type).toBe('design');
    expect(card(id).stepId).toBe('st-3');
    expect(card(id).stepStates).toEqual({});
  });

  it('archive_card_removes_the_card_from_state', async () => {
    const id = await createCard('doomed', 'coding');
    const result = await processor.execute(projectId, { type: 'requestCardArchive', cardId: id });
    expect(result.ok).toBe(true);
    expect(recorded.at(-1)?.eventType).toBe('cardArchived');
    expect(bus.state.byProject.get(projectId)?.cards.has(id)).toBe(false);
  });

  it('assign_then_unassign_rides_cardAssigned_events', async () => {
    const id = await createCard('owned', 'coding');

    const assign = await processor.execute(projectId, {
      type: 'requestCardAssign',
      cardId: id,
      assignee: { role: 'human' },
    });
    expect(assign.ok).toBe(true);
    expect(recorded.at(-1)).toMatchObject({
      eventType: 'cardAssigned',
      body: { cardId: id, assignee: { role: 'human' } },
    });
    expect(card(id).assignee).toEqual({ role: 'human' });

    const unassign = await processor.execute(projectId, {
      type: 'requestCardAssign',
      cardId: id,
    });
    expect(unassign.ok).toBe(true);
    expect(recorded.at(-1)).toMatchObject({ eventType: 'cardAssigned', body: { cardId: id } });
    expect(card(id).assignee).toBeUndefined();
  });

  it('assign_rejects_unknown_card', async () => {
    const result = await processor.execute(projectId, {
      type: 'requestCardAssign',
      cardId: 'T-404',
      assignee: { role: 'human' },
    });
    expect(result.ok).toBe(false);
    expect(result.rejection.code).toBe('unknownCard');
  });

  it('step_state_update_lands_on_the_card_and_rejects_while_running', async () => {
    const id = await createCard('progress', 'coding');
    const result = await processor.execute(projectId, {
      type: 'requestStepStateUpdate',
      cardId: id,
      stepId: 'st-1',
      status: 'ok',
    });
    expect(result.ok).toBe(true);
    expect(card(id).stepStates['st-1']).toBe('ok');

    const unknownStep = await processor.execute(projectId, {
      type: 'requestStepStateUpdate',
      cardId: id,
      stepId: 'st-99',
      status: 'ok',
    });
    expect(unknownStep.ok).toBe(false);
    expect(unknownStep.rejection.code).toBe('unknownStep');

    await bus.publish(projectId, 'pipelineRunStarted', {
      runId: 'R-1',
      cardId: id,
      pipelineId: 'PL-1',
      revision: 1,
    });
    const locked = await processor.execute(projectId, {
      type: 'requestStepStateUpdate',
      cardId: id,
      stepId: 'st-1',
      status: 'pending',
    });
    expect(locked).toEqual({
      ok: false,
      rejection: { code: 'runActive', message: `Card ${id} has an active pipeline run` },
    });
  });

  it('automation_toggle_emits_and_persists_per_pipeline_step', async () => {
    const result = await processor.execute(projectId, {
      type: 'requestAutomationToggle',
      pipelineId: 'PL-1',
      stepId: 'st-2',
      on: false,
    });
    expect(result.ok).toBe(true);
    expect(bus.state.byProject.get(projectId)?.automation.get('PL-1')?.get('st-2')).toBe(false);
    expect(bus.state.byProject.get(projectId)?.automation.get('PL-1')?.get('st-1')).toBeUndefined();

    const unknownStep = await processor.execute(projectId, {
      type: 'requestAutomationToggle',
      pipelineId: 'PL-1',
      stepId: 'st-99',
      on: false,
    });
    expect(unknownStep).toEqual({
      ok: false,
      rejection: { code: 'unknownStep', message: "Step 'st-99' is not a step of pipeline PL-1" },
    });

    const noScope = await processor.execute(undefined, {
      type: 'requestAutomationToggle',
      pipelineId: 'PL-1',
      stepId: 'st-2',
      on: false,
    });
    expect(noScope).toEqual({
      ok: false,
      rejection: { code: 'unknownProject', message: 'Unknown project ' },
    });
  });

  it('the_card_snapshot_replays_into_equal_state', async () => {
    const blocker = await createCard('blocker', 'coding');
    const blocked = await createCard('blocked', 'coding', [blocker]);
    await move(blocker, DONE);
    const design = await createCard('design', 'design');
    await move(design, 'st-2');
    await processor.execute(projectId, {
      type: 'requestStepStateUpdate',
      cardId: design,
      stepId: 'st-1',
      status: 'running',
    });
    await processor.execute(projectId, {
      type: 'requestAutomationToggle',
      pipelineId: 'PL-1',
      stepId: 'st-3',
      on: false,
    });
    await bus.publish(projectId, 'pipelineRunStarted', {
      runId: 'R-1',
      cardId: blocked,
      pipelineId: 'PL-1',
      revision: 1,
    });
    await bus.publish(projectId, 'pipelineStepStarted', {
      runId: 'R-1',
      cardId: blocked,
      pipelineId: 'PL-1',
      stepId: 'st-1',
      kind: 'agent',
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
      projectId: project.projectId,
      cards: [...project.cards.entries()].sort(([a], [b]) => a.localeCompare(b)),
      automation: [...project.automation.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([pipelineId, steps]) => ({
          pipelineId,
          steps: [...steps.entries()].sort(([a], [b]) => a.localeCompare(b)),
        })),
      runs: [...project.runs.entries()].sort(([a], [b]) => a.localeCompare(b)),
    }));
  }
});