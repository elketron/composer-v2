import { Assignee, AutomationState, Card, CardData } from './board.models';
import { Pipeline, PipelineStage } from './pipeline.models';

/** The standard staged pipeline (sg-1..sg-5; Done terminal). */
function pipeline(): Pipeline {
  return new Pipeline({
    id: 'PL-1',
    name: 'Standard coding card',
    revision: 1,
    stages: [
      new PipelineStage({ id: 'sg-1', label: 'New', kanbanVisible: true }),
      new PipelineStage({ id: 'sg-2', label: 'Implementation', kanbanVisible: true }),
      new PipelineStage({ id: 'sg-3', label: 'Validation', kanbanVisible: true }),
      new PipelineStage({ id: 'sg-4', label: 'Approval', kanbanVisible: true }),
      new PipelineStage({ id: 'sg-5', label: 'Done', kanbanVisible: true, terminal: true }),
    ],
    steps: [],
  });
}

function card(overrides: Partial<CardData> & Pick<CardData, 'id' | 'type' | 'stageId'>): Card {
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

/** The real done-ness rule: a card is done in its own pipeline's terminal stage. */
function doneFactory(pipelines: ReadonlyMap<string, Pipeline>): (card: Card) => boolean {
  return (card: Card) => pipelines.get(card.pipelineId)?.terminalStageId === card.stageId;
}

describe('Pipeline stage projection', () => {
  it('projects the Kanban columns from the visible stages, in order', () => {
    expect(pipeline().columns().map((stage) => stage.id)).toEqual([
      'sg-1',
      'sg-2',
      'sg-3',
      'sg-4',
      'sg-5',
    ]);
  });

  it('keeps a card in a hidden stage on its previous visible column', () => {
    const stages = [
      new PipelineStage({ id: 'sg-1', label: 'New', kanbanVisible: true }),
      new PipelineStage({ id: 'sg-2', label: 'Implementation', kanbanVisible: true }),
      new PipelineStage({ id: 'sg-3', label: 'Build', kanbanVisible: false }),
      new PipelineStage({ id: 'sg-4', label: 'Done', kanbanVisible: true, terminal: true }),
    ];
    const p = new Pipeline({ id: 'PL-1', name: 'x', revision: 1, stages, steps: [] });
    expect(p.visibleStageOf('sg-3')).toBe('sg-2');
    expect(p.visibleStageOf('sg-4')).toBe('sg-4');
    expect(p.terminalStageId).toBe('sg-4');
  });
});

describe('Card', () => {
  it('is blocked while any blocker has not reached its terminal stage', () => {
    const done = doneFactory(new Map([['PL-1', pipeline()]]));
    const cards = [
      card({ id: 'T-1', type: 'coding', stageId: 'sg-2' }),
      card({ id: 'T-2', type: 'coding', stageId: 'sg-5' }),
      card({ id: 'T-3', type: 'coding', stageId: 'sg-1', blockedBy: ['T-1'] }),
      card({ id: 'T-4', type: 'coding', stageId: 'sg-1', blockedBy: ['T-2'] }),
      card({ id: 'T-5', type: 'coding', stageId: 'sg-1', blockedBy: ['T-missing'] }),
    ];
    const byId = new Map(cards.map((c) => [c.id, c]));
    expect(cards[2].isBlockedIn(byId, done)).toBe(true);
    expect(cards[3].isBlockedIn(byId, done)).toBe(false);
    expect(cards[4].isBlockedIn(byId, done)).toBe(false);
  });

  it('resolves blockers and blocking cards', () => {
    const cards = [
      card({ id: 'T-1', type: 'coding', stageId: 'sg-2' }),
      card({ id: 'T-3', type: 'coding', stageId: 'sg-1', blockedBy: ['T-1'] }),
      card({ id: 'T-5', type: 'coding', stageId: 'sg-1', blockedBy: ['T-1'] }),
    ];
    const byId = new Map(cards.map((c) => [c.id, c]));
    expect(cards[1].blockers(byId).map((c) => c.id)).toEqual(['T-1']);
    expect(cards[0].blocking(cards).map((c) => c.id)).toEqual(['T-3', 'T-5']);
  });

  it('detects rejection moves: a drag out of the terminal stage', () => {
    const done = doneFactory(new Map([['PL-1', pipeline()]]));
    const completed = card({ id: 'T-1', type: 'coding', stageId: 'sg-5' });
    void done;
    expect(completed.isRejectionMove('sg-2', 'sg-5')).toBe(true);
    expect(completed.isRejectionMove('sg-5', 'sg-5')).toBe(false);
    expect(card({ id: 'T-2', type: 'coding', stageId: 'sg-4' }).isRejectionMove('sg-2', 'sg-5')).toBe(false);
    expect(card({ id: 'T-3', type: 'coding', stageId: 'sg-2' }).isRejectionMove('sg-1', undefined)).toBe(false);
  });

  it('copies with changes, leaving the original untouched', () => {
    const original = card({ id: 'T-1', type: 'coding', stageId: 'sg-1', title: 'before' });
    const moved = original.with({ stageId: 'sg-2', title: 'after' });
    expect(moved.stageId).toBe('sg-2');
    expect(moved.title).toBe('after');
    expect(original.stageId).toBe('sg-1');
    expect(original.title).toBe('before');
  });

  it('carries its per-step execution state', () => {
    const working = card({
      id: 'T-1',
      type: 'coding',
      stageId: 'sg-2',
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
    expect(state.isOn('PL-1', 'sg-2')).toBe(false);
    expect(state.isOn('PL-1', 'sg-3')).toBe(false);
  });

  it('toggles a stage on and back off, keyed per pipeline and stage', () => {
    const on = AutomationState.initial().toggle('PL-1', 'sg-2');
    expect(on.isOn('PL-1', 'sg-2')).toBe(true);
    expect(on.toggle('PL-1', 'sg-2').isOn('PL-1', 'sg-2')).toBe(false);
    // Another pipeline's same-named stage is independent.
    expect(on.isOn('PL-2', 'sg-2')).toBe(false);
    expect(on.set('PL-2', 'sg-2', true).isOn('PL-1', 'sg-2')).toBe(true);
  });
});
