import { TestBed } from '@angular/core/testing';

import {
  FakeEventsClient,
  provideFakeEventsClient,
  seedProject,
  wireEvent,
} from '../core/events/events-client.fake';
import { Assignee, Card, CardData } from '../core/models/board.models';
import { BoardCardComponent } from './board-card.component';

function card(overrides: Partial<CardData> = {}): Card {
  return new Card({
    id: 'T-1',
    type: 'coding',
    title: 'Test card',
    description: 'A description',
    tags: ['ui'],
    pipelineId: 'PL-1',
    stageId: 'sg-2',
    blockedBy: [],
    stepStates: {},
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });
}

/** The staged pipeline body seeded into PipelineService so card lookups resolve. */
function pipelineBody(projectId = 'P-1', hiddenValidation = false) {
  return {
    pipeline: {
      id: 'PL-1',
      projectId,
      name: 'Standard coding card',
      revision: 1,
      updatedAt: new Date().toISOString(),
      stages: [
        { id: 'sg-1', label: 'New', kanbanVisible: true },
        { id: 'sg-2', label: 'Implementation', kanbanVisible: true },
        { id: 'sg-3', label: 'Validation', kanbanVisible: !hiddenValidation },
        { id: 'sg-4', label: 'Approval', kanbanVisible: true },
        { id: 'sg-5', label: 'Done', kanbanVisible: true, terminal: true },
      ],
      steps: [
        { id: 'st-1', kind: 'agent', stageId: 'sg-2', agentKind: 'coder', instructions: 'Implement.' },
        { id: 'st-2', kind: 'command', stageId: 'sg-3', command: 'npm test', description: 'Tests' },
        { id: 'st-3', kind: 'human', stageId: 'sg-4', description: 'Approval' },
      ],
    },
  };
}

describe('BoardCardComponent', () => {
  let events: FakeEventsClient;

  beforeEach(async () => {
    events = new FakeEventsClient();
    await TestBed.configureTestingModule({
      imports: [BoardCardComponent],
      providers: [provideFakeEventsClient(events)],
    }).compileComponents();
  });

  /**
   * Renders first (services subscribe at construction), then seeds the
   * project and its pipeline so the folds land.
   */
  async function render(c: Card, blocked = false) {
    const fixture = TestBed.createComponent(BoardCardComponent);
    fixture.componentRef.setInput('card', c);
    fixture.componentRef.setInput('blocked', blocked);
    await fixture.whenStable();
    seedProject(events, 'P-1');
    events.emit(wireEvent('pipelineSaved', pipelineBody(), 'P-1'));
    await fixture.whenStable();
    return fixture;
  }

  it('renders id, title, snippet and tags', async () => {
    const fixture = await render(card({ id: 'T-42', title: 'Hello', tags: ['a', 'b'] }));
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('T-42');
    expect(el.textContent).toContain('Hello');
    expect(el.textContent).toContain('A description');
    expect(el.querySelectorAll('.tag').length).toBe(2);
  });

  it('shows unassigned without a pulse and relative age', async () => {
    const el = (await render(card())).nativeElement as HTMLElement;
    expect(el.textContent).toContain('unassigned');
    expect(el.textContent).toContain('1h ago');
    expect(el.querySelector('.dot.pulse')).toBeNull();
  });

  it('pulses the assignee dot while a run works the card', async () => {
    const fixture = await render(card({ assignee: Assignee.for('coder', 'gpt-5.4', 'medium') }));
    const el = fixture.nativeElement as HTMLElement;
    events.emit(
      wireEvent('pipelineRunStarted', { runId: 'R-1', cardId: 'T-1', pipelineId: 'PL-1', revision: 1 }),
    );
    await fixture.whenStable();
    expect(el.textContent).toContain('gpt-5.4 · medium');
    expect(el.querySelector('.dot.pulse')).toBeTruthy();
  });

  it('labels the human assignee as you', async () => {
    const el = (await render(card({ assignee: Assignee.human() })))
      .nativeElement as HTMLElement;
    expect(el.textContent).toContain('you');
  });

  it('shows the run chip while a pipeline works the card, pulsing at the gate', async () => {
    const fixture = await render(card());
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.run-chip')).toBeNull();

    events.emit(
      wireEvent('pipelineRunStarted', { runId: 'R-1', cardId: 'T-1', pipelineId: 'PL-1', revision: 1 }),
    );
    await fixture.whenStable();
    const chip = el.querySelector('.run-chip');
    expect(chip?.textContent).toContain('queued');
    expect(chip?.classList).not.toContain('waiting');

    events.emit(
      wireEvent('pipelineStepStarted', {
        runId: 'R-1',
        cardId: 'T-1',
        pipelineId: 'PL-1',
        stepId: 'st-3',
        kind: 'human',
        stageId: 'sg-4',
      }),
    );
    await fixture.whenStable();
    expect(el.querySelector('.run-chip')?.textContent).toContain('approval');
    expect(el.querySelector('.run-chip')?.classList).toContain('waiting');

    events.emit(
      wireEvent('pipelineRunEnded', {
        runId: 'R-1',
        cardId: 'T-1',
        pipelineId: 'PL-1',
        revision: 1,
        status: 'completed',
      }),
    );
    await fixture.whenStable();
    expect(el.querySelector('.run-chip')).toBeNull();
  });

  it('shows the hidden stage and current step when execution is inside a hidden stage', async () => {
    // A revision where sg-3 (Validation) is not a Kanban column.
    const hidden = card({ stageId: 'sg-3' });
    const fixture = await render(hidden);
    const el = fixture.nativeElement as HTMLElement;
    const body = pipelineBody();
    (body.pipeline.stages[2] as { kanbanVisible: boolean }).kanbanVisible = false;
    (body.pipeline as { revision: number }).revision = 2;
    events.emit(wireEvent('pipelineSaved', body, 'P-1'));
    await fixture.whenStable();
    expect(el.querySelector('.hidden-stage')?.textContent).toContain('Validation');

    events.emit(
      wireEvent('pipelineRunStarted', { runId: 'R-1', cardId: 'T-1', pipelineId: 'PL-1', revision: 2 }),
    );
    events.emit(
      wireEvent('pipelineStepStarted', {
        runId: 'R-1',
        cardId: 'T-1',
        pipelineId: 'PL-1',
        stepId: 'st-2',
        kind: 'command',
        stageId: 'sg-3',
      }),
    );
    await fixture.whenStable();
    expect(el.querySelector('.hidden-stage')?.textContent).toContain('Tests');

    // A visible stage renders no hidden-stage line.
    const visible = (await render(card({ id: 'T-2', stageId: 'sg-2' }))).nativeElement as HTMLElement;
    expect(visible.querySelector('.hidden-stage')).toBeNull();
  });

  it('renders the lock chip with blocker count when blocked', async () => {
    const el = (await render(card({ stageId: 'sg-1', blockedBy: ['T-9', 'T-10'] }), true))
      .nativeElement as HTMLElement;
    const lock = el.querySelector('.lock');
    expect(lock?.textContent?.trim()).toContain('2');
    expect(lock?.getAttribute('title')).toBe('blocked by T-9, T-10');
    expect(el.querySelector('.card')!.classList).toContain('blocked');
  });

  it('renders file stats only when non-zero', async () => {
    const withStats = (await render(card({ fileStats: { added: 51, removed: 8, files: 3 } })))
      .nativeElement as HTMLElement;
    expect(withStats.textContent).toContain('+51');
    expect(withStats.textContent).toContain('−8');

    const without = (await render(card())).nativeElement as HTMLElement;
    expect(without.textContent).toContain('no changes');
  });

  it('shows the session link when present', async () => {
    const el = (await render(card({ sessionId: 's-9f2c' }))).nativeElement as HTMLElement;
    expect(el.textContent).toContain('s-9f2c');
  });

  it('emits activated on click and on Enter', async () => {
    const fixture = await render(card({ id: 'T-7' }));
    const emitted: string[] = [];
    fixture.componentInstance.activated.subscribe((c: Card) => emitted.push(c.id));

    (fixture.nativeElement as HTMLElement).click();
    fixture.nativeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(emitted).toEqual(['T-7', 'T-7']);
  });
});
