// The project domain: validation order, rejection messages, and the
// emitted events match v1's processor (create_project, set_directory,
// activate). The fold and the snapshot round-trip into equal state.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Bus } from '../src/bus.js';
import { Processor } from '../src/processor.js';
import { apply } from '../src/fold.js';
import { snapshotEvents } from '../src/snapshot.js';
import { newState, type CardState, type State } from '../src/fold.js';
import { subStateFor, type Card, type CardType, type Stage } from '../src/wire/models.js';
import type { EventFrame } from '../src/wire/envelope.js';

let dir: string;
let store: InstanceType<typeof import('../src/store.js').EventStore>;
let bus: Bus;
let processor: Processor;
const recorded: EventFrame[] = [];

beforeEach(async () => {
  recorded.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'composer-proc-'));
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

const ProjectCreated = 'projectCreated' as const;

/** A blank card the way the action mapper builds one (id/timestamps unset). */
function blankCard(projectId: string, type: CardType, title: string, blockedBy: string[] = []): Card {
  return {
    id: '',
    projectId,
    type,
    title,
    description: '',
    tags: [],
    stage: 'new',
    blockedBy,
    subState: {},
    retries: {},
    createdAt: '',
    updatedAt: '',
  };
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

  it('create_project_emits_created_then_activated', async () => {
    await processor.execute(undefined, { type: 'requestProjectCreate', name: 'alpha' });
    expect(recorded.map((frame) => frame.eventType)).toEqual([
      ProjectCreated,
      'projectActivated',
      'pipelineSaved',
    ]);
    const project = (recorded[0]?.body as { project: { id: string } }).project;
    expect(project.id).toBe('P-1');
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

  it('the_snapshot_replays_into_equal_state', async () => {
    await processor.execute(undefined, { type: 'requestProjectCreate', name: 'alpha' });
    await processor.execute(undefined, { type: 'requestProjectCreate', name: 'beta', directory: dir });

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

  function card(id: string): CardState {
    const card = bus.state.byProject.get(projectId)?.cards.get(id);
    if (!card) throw new Error(`card ${id} not in state`);
    return card;
  }

  function move(cardId: string, toLane: Stage, override = false, comment?: string) {
    return processor.execute(projectId, {
      type: 'requestCardMove',
      cardId,
      toLane,
      override,
      ...(comment !== undefined ? { comment } : {}),
    });
  }

  it('card_create_assigns_sequential_ids_and_initial_sub_state', async () => {
    const first = await createCard('one', 'coding');
    const second = await createCard('two', 'coding');
    expect(first).toBe('T-1');
    expect(second).toBe('T-2');
    expect(card(first).subState).toEqual(subStateFor('coding'));
  });

  it('card_create_rejects_unknown_scope_and_unknown_blockers', async () => {
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
  });

  it('blocked_card_emits_dependency_state_changed', async () => {
    const blocker = await createCard('blocker', 'coding');
    await createCard('blocked', 'coding', [blocker]);
    const dep = recorded.filter((frame) => frame.eventType === 'dependencyStateChanged')[0];
    expect(dep?.body).toEqual({ cardId: 'T-2', blocked: true, blockedBy: [blocker] });
  });

  it('move_card_validates_lane_type_and_blockers', async () => {
    const design = await createCard('design card', 'design');
    const invalid = await move(design, 'security');
    expect(invalid).toEqual({
      ok: false,
      rejection: { code: 'invalidLane', message: 'Lane Security is not valid for Design cards' },
    });

    const blocker = await createCard('blocker', 'coding');
    const blocked = await createCard('blocked', 'coding', [blocker]);
    const rejectedMove = await move(blocked, 'coding', false);
    expect(rejectedMove).toEqual({
      ok: false,
      rejection: { code: 'blocked', message: `Card ${blocked} has unsatisfied blockers` },
    });

    const forced = await move(blocked, 'coding', true);
    expect(forced).toEqual({ ok: true });
  });

  it('move_card_rejects_unknown_card_and_no_ops_on_same_lane', async () => {
    const unknown = await move('T-99', 'coding');
    expect(unknown).toEqual({
      ok: false,
      rejection: { code: 'unknownCard', message: 'Unknown card T-99' },
    });

    const id = await createCard('still in new', 'coding');
    const before = recorded.length;
    const noOp = await move(id, 'new');
    expect(noOp).toEqual({ ok: true });
    expect(recorded.length).toBe(before);
  });

  it('drag_to_new_unassigns', async () => {
    const id = await createCard('assigned', 'coding');
    const assigned = { ...card(id), assignee: { role: 'coder', model: 'm', effort: 'e' } };
    await bus.publish(projectId, 'cardCreated', { card: assigned });

    expect((await move(id, 'coding')).ok).toBe(true);
    expect(card(id).assignee).toEqual({ role: 'coder', model: 'm', effort: 'e' });

    const result = await move(id, 'new');
    expect(result.ok).toBe(true);
    expect(card(id).assignee).toBeUndefined();
  });

  it('the_move_comment_records_the_rejection_comment', async () => {
    const id = await createCard('rejected', 'coding');
    await move(id, 'coding');
    await move(id, 'approval');
    await move(id, 'coding', false, 'needs tests');
    expect(card(id).rejectionComment).toBe('needs tests');
  });

  it('blocker_reaching_done_unblocks_dependents', async () => {
    const blocker = await createCard('blocker', 'coding');
    const blocked = await createCard('blocked', 'coding', [blocker]);
    expect(
      card(blocked).blockedBy.some((id) => card(id)?.stage !== 'done'),
    ).toBe(true);

    await move(blocker, 'coding');
    await move(blocker, 'done');
    const deps = recorded
      .filter((frame) => frame.eventType === 'dependencyStateChanged')
      .map((frame) => frame.body as { cardId: string; blocked: boolean })
      .filter((body) => body.cardId === blocked);
    expect(deps.at(-1)?.blocked).toBe(false);
  });

  it('type_change_resets_sub_state_and_falls_back_to_new', async () => {
    const id = await createCard('in security', 'coding');
    await move(id, 'security');

    const result = await processor.execute(projectId, {
      type: 'requestCardTypeChange',
      cardId: id,
      toType: 'design',
    });
    expect(result.ok).toBe(true);
    const changed = recorded.filter((frame) => frame.eventType === 'cardTypeChanged')[0];
    expect(changed?.body).toMatchObject({ cardId: id, from: 'coding' });

    expect(card(id).type).toBe('design');
    expect(card(id).stage).toBe('new'); // security is not a design lane
    expect(card(id).subState).toEqual(subStateFor('design'));
  });

  it('archive_card_removes_the_card_from_state', async () => {
    const id = await createCard('doomed', 'coding');
    const result = await processor.execute(projectId, { type: 'requestCardArchive', cardId: id });
    expect(result.ok).toBe(true);
    expect(recorded.at(-1)?.eventType).toBe('cardArchived');
    expect(bus.state.byProject.get(projectId)?.cards.has(id)).toBe(false);
  });

  it('sub_state_update_lands_on_the_card', async () => {
    const id = await createCard('progress', 'coding');
    const result = await processor.execute(projectId, {
      type: 'requestSubStateUpdate',
      cardId: id,
      stage: 'implement',
      status: 'ok',
    });
    expect(result.ok).toBe(true);
    expect(card(id).subState['implement']).toBe('ok');
  });

  it('automation_toggle_emits_and_persists_per_project', async () => {
    const result = await processor.execute(projectId, {
      type: 'requestAutomationToggle',
      lane: 'security',
      on: false,
    });
    expect(result.ok).toBe(true);
    expect(bus.state.byProject.get(projectId)?.automation.get('security')).toBe(false);
    expect(bus.state.byProject.get(projectId)?.automation.get('coding')).toBeUndefined();

    const unknown = await processor.execute(undefined, {
      type: 'requestAutomationToggle',
      lane: 'coding',
      on: false,
    });
    expect(unknown).toEqual({
      ok: false,
      rejection: { code: 'unknownProject', message: 'Unknown project ' },
    });
  });

  it('the_card_snapshot_replays_into_equal_state', async () => {
    const blocker = await createCard('blocker', 'coding');
    const blocked = await createCard('blocked', 'coding', [blocker]);
    await move(blocker, 'done');
    const design = await createCard('design', 'design');
    await move(design, 'design');
    await processor.execute(projectId, {
      type: 'requestSubStateUpdate',
      cardId: design,
      stage: 'draft',
      status: 'running',
    });
    await processor.execute(projectId, {
      type: 'requestAutomationToggle',
      lane: 'review',
      on: false,
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
      automation: [...project.automation.entries()].sort(([a], [b]) => a.localeCompare(b)),
    }));
  }
});
