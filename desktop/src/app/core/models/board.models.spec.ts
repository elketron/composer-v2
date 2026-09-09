import { Assignee, AutomationState, Card, CardData } from './board.models';
import { Pipeline, PipelineStep } from './pipeline.models';

/** The standard step path (st-1..st-4; st-4 terminal). */
function pipeline(): Pipeline {
  return new Pipeline({
    id: 'PL-1',
    name: 'Standard coding card',
    revision: 1,
    steps: [
      new PipelineStep({ id: 'st-1', kind: 'agent', boardVisible: true, agentKind: 'coder', instructions: 'Implement.' }),
      new PipelineStep({ id: 'st-2', kind: 'command', boardVisible: false, command: 'npm test' }),
      new PipelineStep({ id: 'st-3', kind: 'human', boardVisible: true, description: 'Approval' }),
      new PipelineStep({ id: 'st-4', kind: 'human', boardVisible: true, terminal: true }),
    ],
  });
}

function card(overrides: Partial<CardData> & Pick<CardData, 'id' | 'type' | 'stepId'>): Card {
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

/** The real done-ness rule: a card is done at its own pipeline's terminal step. */
function doneFactory(pipelines: ReadonlyMap<string, Pipeline>): (card: Card) => boolean {
  return (card: Card) => pipelines.get(card.pipelineId)?.terminalStepId === card.stepId;
}

describe('Pipeline step projection', () => {
  it('projects the board swimlanes from the board-visible steps, in order', () => {
    expect(pipeline().columns().map((step) => step.id)).toEqual(['st-1', 'st-3', 'st-4']);
  });

  it('keeps a card in a hidden step on its previous visible swimlane', () => {
    const steps = [
      new PipelineStep({ id: 'st-1', kind: 'agent', boardVisible: true, agentKind: 'coder', instructions: 'x' }),
      new PipelineStep({ id: 'st-2', kind: 'command', boardVisible: false, command: 'true' }),
      new PipelineStep({ id: 'st-3', kind: 'human', boardVisible: true, terminal: true }),
    ];
    const p = new Pipeline({ id: 'PL-1', name: 'x', revision: 1, steps });
    expect(p.visibleStepOf('st-2')).toBe('st-1');
    expect(p.visibleStepOf('st-3')).toBe('st-3');
    expect(p.terminalStepId).toBe('st-3');
  });
});

describe('Card', () => {
  it('is blocked while any blocker has not reached its terminal step', () => {
    const done = doneFactory(new Map([['PL-1', pipeline()]]));
    const cards = [
      card({ id: 'T-1', type: 'coding', stepId: 'st-1' }),
      card({ id: 'T-2', type: 'coding', stepId: 'st-4' }),
      card({ id: 'T-3', type: 'coding', stepId: 'st-1', blockedBy: ['T-1'] }),
      card({ id: 'T-4', type: 'coding', stepId: 'st-1', blockedBy: ['T-2'] }),
      card({ id: 'T-5', type: 'coding', stepId: 'st-1', blockedBy: ['T-missing'] }),
    ];
    const byId = new Map(cards.map((c) => [c.id, c]));
    expect(cards[2].isBlockedIn(byId, done)).toBe(true);
    expect(cards[3].isBlockedIn(byId, done)).toBe(false);
    expect(cards[4].isBlockedIn(byId, done)).toBe(false);
  });

  it('resolves blockers and blocking cards', () => {
    const cards = [
      card({ id: 'T-1', type: 'coding', stepId: 'st-1' }),
      card({ id: 'T-3', type: 'coding', stepId: 'st-1', blockedBy: ['T-1'] }),
      card({ id: 'T-5', type: 'coding', stepId: 'st-1', blockedBy: ['T-1'] }),
    ];
    const byId = new Map(cards.map((c) => [c.id, c]));
    expect(cards[1].blockers(byId).map((c) => c.id)).toEqual(['T-1']);
    expect(cards[0].blocking(cards).map((c) => c.id)).toEqual(['T-3', 'T-5']);
  });

  it('detects rejection moves: a drag out of the terminal step', () => {
    const completed = card({ id: 'T-1', type: 'coding', stepId: 'st-4' });
    expect(completed.isRejectionMove('st-1', 'st-4')).toBe(true);
    expect(completed.isRejectionMove('st-4', 'st-4')).toBe(false);
    expect(card({ id: 'T-2', type: 'coding', stepId: 'st-3' }).isRejectionMove('st-1', 'st-4')).toBe(false);
    expect(card({ id: 'T-3', type: 'coding', stepId: 'st-1' }).isRejectionMove('st-1', undefined)).toBe(false);
  });

  it('copies with changes, leaving the original untouched', () => {
    const original = card({ id: 'T-1', type: 'coding', stepId: 'st-1', title: 'before' });
    const moved = original.with({ stepId: 'st-2', title: 'after' });
    expect(moved.stepId).toBe('st-2');
    expect(moved.title).toBe('after');
    expect(original.stepId).toBe('st-1');
    expect(original.title).toBe('before');
  });

  it('carries its per-step execution state', () => {
    const working = card({
      id: 'T-1',
      type: 'coding',
      stepId: 'st-1',
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
    expect(state.isOn('PL-1', 'st-1')).toBe(false);
    expect(state.isOn('PL-1', 'st-2')).toBe(false);
  });

  it('toggles a step on and back off, keyed per pipeline and step', () => {
    const on = AutomationState.initial().toggle('PL-1', 'st-1');
    expect(on.isOn('PL-1', 'st-1')).toBe(true);
    expect(on.toggle('PL-1', 'st-1').isOn('PL-1', 'st-1')).toBe(false);
    // Another pipeline's same-named step is independent.
    expect(on.isOn('PL-2', 'st-1')).toBe(false);
    expect(on.set('PL-2', 'st-1', true).isOn('PL-1', 'st-1')).toBe(true);
  });
});