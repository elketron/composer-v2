import { Assignee, AutomationState, Card, CardData } from './board.models';
import { Pipeline, PipelineLane, PipelineStep } from './pipeline.models';

/** The standard lane path (ln-1..ln-3; ln-3 terminal). */
function pipeline(): Pipeline {
  return new Pipeline({
    id: 'PL-1',
    name: 'Standard coding card',
    revision: 1,
    lanes: [
      new PipelineLane('ln-1', 'Implementation', true, false),
      new PipelineLane('ln-2', 'Approval', true, false),
      new PipelineLane('ln-3', 'Done', true, true),
    ],
    steps: [
      new PipelineStep({ id: 'st-1', kind: 'agent', laneId: 'ln-1', agentKind: 'coder', instructions: 'Implement.' }),
      new PipelineStep({ id: 'st-2', kind: 'command', laneId: 'ln-1', command: 'npm test' }),
      new PipelineStep({ id: 'st-3', kind: 'human', laneId: 'ln-2', description: 'Approval' }),
    ],
  });
}

function card(overrides: Partial<CardData> & Pick<CardData, 'id' | 'type' | 'laneId'>): Card {
  return new Card({
    title: 't',
    description: '',
    tags: [],
    pipelineId: 'PL-1',
    blockedBy: [],
    stepStates: {},
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  });
}

/** The real done-ness rule: a card is done at its own pipeline's terminal lane. */
function doneFactory(pipelines: ReadonlyMap<string, Pipeline>): (card: Card) => boolean {
  return (card: Card) => pipelines.get(card.pipelineId)?.isTerminalLane(card.laneId) ?? false;
}

describe('Pipeline lane projection', () => {
  it('projects the board columns from the kanban-visible lanes, in order', () => {
    expect(pipeline().columns().map((lane) => lane.id)).toEqual(['ln-1', 'ln-2', 'ln-3']);
  });

  it('names the terminal lane and labels the lanes', () => {
    const p = pipeline();
    expect(p.terminalLaneId).toBe('ln-3');
    expect(p.isTerminalLane('ln-3')).toBe(true);
    expect(p.isTerminalLane('ln-1')).toBe(false);
    expect(p.laneLabel('ln-1')).toBe('Implementation');
    expect(p.laneLabel('missing')).toBe('missing');
  });
});

describe('Card', () => {
  it('is blocked while any blocker has not reached its terminal lane', () => {
    const done = doneFactory(new Map([['PL-1', pipeline()]]));
    const cards = [
      card({ id: 'T-1', type: 'coding', laneId: 'ln-1' }),
      card({ id: 'T-2', type: 'coding', laneId: 'ln-3' }),
      card({ id: 'T-3', type: 'coding', laneId: 'ln-1', blockedBy: ['T-1'] }),
      card({ id: 'T-4', type: 'coding', laneId: 'ln-1', blockedBy: ['T-2'] }),
      card({ id: 'T-5', type: 'coding', laneId: 'ln-1', blockedBy: ['T-missing'] }),
    ];
    const byId = new Map(cards.map((c) => [c.id, c]));
    expect(cards[2].isBlockedIn(byId, done)).toBe(true);
    expect(cards[3].isBlockedIn(byId, done)).toBe(false);
    expect(cards[4].isBlockedIn(byId, done)).toBe(false);
  });

  it('resolves blockers and blocking cards', () => {
    const cards = [
      card({ id: 'T-1', type: 'coding', laneId: 'ln-1' }),
      card({ id: 'T-3', type: 'coding', laneId: 'ln-1', blockedBy: ['T-1'] }),
      card({ id: 'T-5', type: 'coding', laneId: 'ln-1', blockedBy: ['T-1'] }),
    ];
    const byId = new Map(cards.map((c) => [c.id, c]));
    expect(cards[1].blockers(byId).map((c) => c.id)).toEqual(['T-1']);
    expect(cards[0].blocking(cards).map((c) => c.id)).toEqual(['T-3', 'T-5']);
  });

  it('detects rejection moves: a drag out of the terminal lane', () => {
    const completed = card({ id: 'T-1', type: 'coding', laneId: 'ln-3' });
    expect(completed.isRejectionMove('ln-1', 'ln-3')).toBe(true);
    expect(completed.isRejectionMove('ln-3', 'ln-3')).toBe(false);
    expect(card({ id: 'T-2', type: 'coding', laneId: 'ln-2' }).isRejectionMove('ln-1', 'ln-3')).toBe(false);
    expect(card({ id: 'T-3', type: 'coding', laneId: 'ln-1' }).isRejectionMove('ln-1', undefined)).toBe(false);
  });

  it('copies with changes, leaving the original untouched', () => {
    const original = card({ id: 'T-1', type: 'coding', laneId: 'ln-1', title: 'before' });
    const moved = original.with({ laneId: 'ln-2', title: 'after' });
    expect(moved.laneId).toBe('ln-2');
    expect(moved.title).toBe('after');
    expect(original.laneId).toBe('ln-1');
    expect(original.title).toBe('before');
  });

  it('carries its per-step execution state', () => {
    const working = card({
      id: 'T-1',
      type: 'coding',
      laneId: 'ln-1',
      stepStates: { 'st-1': 'ok', 'st-2': 'running' },
    });
    expect(working.stepStates['st-1']).toBe('ok');
    expect(working.stepStates['st-2']).toBe('running');
    expect(working.with({ stepStates: { 'st-1': 'failed' } }).stepStates['st-1']).toBe('failed');
  });
});

describe('Assignee', () => {
  it('labels agents as model · effort', () => {
    expect(Assignee.for('coder', 'gpt-5.4', 'medium').label).toBe('gpt-5.4 · medium');
  });

  it('labels the human assignee as you', () => {
    const human = Assignee.human();
    expect(human.isHuman).toBe(true);
    expect(human.label).toBe('you');
  });
});

describe('AutomationState', () => {
  it('starts with every toggle off (state rides the events)', () => {
    const state = AutomationState.initial();
    expect(state.isOn('PL-1', 'ln-1')).toBe(false);
    expect(state.isOn('PL-1', 'ln-2')).toBe(false);
  });

  it('toggles a lane on and back off, keyed per pipeline and lane', () => {
    const on = AutomationState.initial().toggle('PL-1', 'ln-1');
    expect(on.isOn('PL-1', 'ln-1')).toBe(true);
    expect(on.toggle('PL-1', 'ln-1').isOn('PL-1', 'ln-1')).toBe(false);
    // Another pipeline's same-named lane is independent.
    expect(on.isOn('PL-2', 'ln-1')).toBe(false);
    expect(on.set('PL-2', 'ln-1', true).isOn('PL-1', 'ln-1')).toBe(true);
  });
});
