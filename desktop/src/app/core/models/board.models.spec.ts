import {
  Assignee,
  AutomationState,
  Card,
  CardData,
  CardType,
  Column,
  Lane,
  Stage,
} from './board.models';

function card(overrides: Partial<CardData> & Pick<CardData, 'id' | 'type' | 'stage'>): Card {
  return new Card({
    title: 't',
    description: '',
    tags: [],
    blockedBy: [],
    subState: {},
    retries: {},
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  });
}

describe('Lane', () => {
  it('routes coding cards through security', () => {
    expect(Lane.forType('coding')).toEqual([
      'new',
      'coding',
      'validation',
      'review',
      'security',
      'approval',
      'done',
    ]);
  });

  it('skips security for design and docs', () => {
    expect(Lane.forType('design')).not.toContain('security');
    expect(Lane.forType('docs')).not.toContain('security');
  });

  it('ALL is the union of per-type lanes', () => {
    const union = new Set([
      ...Lane.forType('coding'),
      ...Lane.forType('design'),
      ...Lane.forType('docs'),
    ]);
    expect(new Set(Lane.ALL)).toEqual(union);
    expect(Lane.ALL.length).toBe(union.size);
  });

  it('validates lanes per type', () => {
    expect(Lane.isValidFor('coding', 'security')).toBe(true);
    expect(Lane.isValidFor('design', 'design')).toBe(true);
    expect(Lane.isValidFor('design', 'security')).toBe(false);
    expect(Lane.isValidFor('docs', 'coding')).toBe(false);
    expect(Lane.isValidFor('coding', 'design')).toBe(false);
  });

  it('resolves the implement lane from the type', () => {
    expect(Lane.implementFor('coding')).toBe('coding');
    expect(Lane.implementFor('design')).toBe('design');
    expect(Lane.implementFor('docs')).toBe('docs');
  });

  it('knows which lanes are agent-owned', () => {
    expect(Lane.isAgentOwned('coding')).toBe(true);
    expect(Lane.isAgentOwned('security')).toBe(true);
    expect(Lane.isAgentOwned('new')).toBe(false);
    expect(Lane.isAgentOwned('approval')).toBe(false);
    expect(Lane.isAgentOwned('done')).toBe(false);
  });
});

describe('Card', () => {
  const cards = [
    card({ id: 'T-1', type: 'coding', stage: 'coding' }),
    card({ id: 'T-2', type: 'coding', stage: 'done' }),
    card({ id: 'T-3', type: 'coding', stage: 'new', blockedBy: ['T-1'] }),
    card({ id: 'T-4', type: 'coding', stage: 'new', blockedBy: ['T-2'] }),
    card({ id: 'T-5', type: 'coding', stage: 'new', blockedBy: ['T-1', 'T-2'] }),
    card({ id: 'T-6', type: 'coding', stage: 'new', blockedBy: ['T-missing'] }),
  ];
  const byId = new Map(cards.map((c) => [c.id, c]));

  it('is blocked while any blocker is not done', () => {
    expect(cards[2].isBlockedIn(byId)).toBe(true);
    expect(cards[4].isBlockedIn(byId)).toBe(true);
  });

  it('is unblocked when all blockers are done', () => {
    expect(cards[3].isBlockedIn(byId)).toBe(false);
  });

  it('treats missing blockers as non-blocking', () => {
    expect(cards[5].isBlockedIn(byId)).toBe(false);
  });

  it('resolves blockers and blocking cards', () => {
    expect(cards[2].blockers(byId).map((c) => c.id)).toEqual(['T-1']);
    expect(cards[0].blocking(cards).map((c) => c.id)).toEqual(['T-3', 'T-5']);
  });

  it('filters cards in a lane by type and stage', () => {
    const mixed = [
      card({ id: 'T-1', type: 'coding', stage: 'new' }),
      card({ id: 'T-2', type: 'design', stage: 'new' }),
      card({ id: 'T-3', type: 'coding', stage: 'coding' }),
    ];
    expect(Card.inLane(mixed, 'coding', 'new').map((c) => c.id)).toEqual(['T-1']);
  });

  it('detects rejection moves: approval back to the implement lane', () => {
    const inApproval = card({ id: 'T-1', type: 'coding', stage: 'approval' });
    expect(inApproval.isRejectionMove('coding')).toBe(true);
    expect(inApproval.isRejectionMove('done')).toBe(false);
    expect(inApproval.isRejectionMove('new')).toBe(false);

    const inReview = card({ id: 'T-2', type: 'coding', stage: 'review' });
    expect(inReview.isRejectionMove('coding')).toBe(false);
  });

  it('is working when assigned in an agent-owned lane', () => {
    const assignee = Assignee.for('coder', 'gpt-5.4', 'medium');
    expect(card({ id: 'T-1', type: 'coding', stage: 'coding', assignee }).isWorking()).toBe(true);
    expect(card({ id: 'T-1', type: 'coding', stage: 'coding' }).isWorking()).toBe(false);
    expect(card({ id: 'T-1', type: 'coding', stage: 'approval', assignee }).isWorking()).toBe(false);
  });

  it('builds a pending checklist per type, filling gaps with pending', () => {
    const coding = card({
      id: 'T-1',
      type: 'coding',
      stage: 'coding',
      subState: { retrieveContext: 'ok', implement: 'running' },
      retries: { implement: 2 },
    });
    const checklist = coding.checklist();
    expect(checklist.map((e) => e.label)).toEqual([
      'retrieve context',
      'implement',
      'write tests',
      'run validation',
      'review changes',
      'security review',
      'human review',
    ]);
    expect(checklist[0].status).toBe('ok');
    expect(checklist[1]).toMatchObject({ status: 'running', retries: 2 });
    expect(checklist[2]).toMatchObject({ status: 'pending', retries: 0 });

    const design = card({ id: 'T-2', type: 'design', stage: 'design' });
    expect(design.checklist().map((e) => e.stage)).toEqual([
      'draft',
      'implement',
      'runValidation',
      'reviewChanges',
      'humanReview',
    ]);
  });

  it('initialSubState creates a pending checklist per type', () => {
    const coding = card({ id: 'T-1', type: 'coding', stage: 'coding' });
    const design = card({ id: 'T-2', type: 'design', stage: 'design' });
    expect(Card.initialSubState('coding')).toEqual(
      Object.fromEntries(coding.checklistStages().map((s) => [s, 'pending'])),
    );
    expect(Object.keys(Card.initialSubState('design'))).toEqual(design.checklistStages());
  });

  it('copies with changes, leaving the original untouched', () => {
    const original = card({ id: 'T-1', type: 'coding', stage: 'new', title: 'before' });
    const moved = original.with({ stage: 'coding', title: 'after' });
    expect(moved.stage).toBe('coding');
    expect(moved.title).toBe('after');
    expect(original.stage).toBe('new');
    expect(original.title).toBe('before');
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

describe('Column', () => {
  it('shows the work states in board order', () => {
    expect(Column.ALL).toEqual([
      'backlog',
      'coder',
      'tester',
      'reviewer',
      'security',
      'approval',
      'done',
    ]);
  });

  it('collapses the type-named implement stages into the coder column', () => {
    expect(Column.STAGES_OF['coder']).toEqual(['coding', 'design', 'docs']);
    expect(Column.inColumn([
      card({ id: 'T-1', type: 'coding', stage: 'coding' }),
      card({ id: 'T-2', type: 'design', stage: 'design' }),
      card({ id: 'T-3', type: 'coding', stage: 'new' }),
    ], 'coder').map((c) => c.id)).toEqual(['T-1', 'T-2']);
  });

  it('drops into a column on the concrete stage the card routes through', () => {
    expect(Column.dropStage('backlog', 'coding')).toBe('new');
    expect(Column.dropStage('coder', 'coding')).toBe('coding');
    expect(Column.dropStage('coder', 'design')).toBe('design');
    expect(Column.dropStage('tester', 'coding')).toBe('validation');
    expect(Column.dropStage('done', 'docs')).toBe('done');
  });

  it('marks the agent-worked columns for automation toggles', () => {
    expect(Column.isAgentOwned('coder')).toBe(true);
    expect(Column.isAgentOwned('tester')).toBe(true);
    expect(Column.isAgentOwned('reviewer')).toBe(true);
    expect(Column.isAgentOwned('security')).toBe(true);
    expect(Column.isAgentOwned('backlog')).toBe(false);
    expect(Column.isAgentOwned('approval')).toBe(false);
    expect(Column.isAgentOwned('done')).toBe(false);
  });
});

describe('AutomationState', () => {
  it('starts with every agent-owned lane on', () => {
    const state = AutomationState.initial();
    for (const lane of Lane.AGENT_OWNED) {
      expect(state.isOn(lane)).toBe(true);
    }
    expect(state.onCount).toBe(Lane.AGENT_OWNED.size);
  });

  it('toggles a lane off and back on', () => {
    const off = AutomationState.initial().toggle('coding');
    expect(off.isOn('coding')).toBe(false);
    expect(off.onCount).toBe(Lane.AGENT_OWNED.size - 1);
    expect(off.toggle('coding').isOn('coding')).toBe(true);
  });

  it('ignores lanes that are not agent-owned', () => {
    const state = AutomationState.initial();
    expect(state.toggle('new')).toBe(state);
    expect(state.isOn('new')).toBe(false);
  });
});
