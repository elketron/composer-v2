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
    stage: 'coding',
    blockedBy: [],
    subState: {},
    retries: {},
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });
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

  async function render(c: Card, blocked = false) {
    const fixture = TestBed.createComponent(BoardCardComponent);
    fixture.componentRef.setInput('card', c);
    fixture.componentRef.setInput('blocked', blocked);
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

  it('pulses the assignee dot while an agent works the card', async () => {
    const el = (
      await render(
        card({ assignee: Assignee.for('coder', 'gpt-5.4', 'medium'), stage: 'coding' }),
      )
    ).nativeElement as HTMLElement;
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

    // The run selector keys on the shell's active tab; the seed
    // auto-activates the project (services subscribed at render).
    seedProject(events, 'P-1');
    events.emit(wireEvent('pipelineRunStarted', { cardId: 'T-1', pipelineId: 'PL-1' }));
    await fixture.whenStable();
    const chip = el.querySelector('.run-chip');
    expect(chip?.textContent).toContain('queued');
    expect(chip?.classList).not.toContain('waiting');

    events.emit(
      wireEvent('pipelineStepStarted', { cardId: 'T-1', pipelineId: 'PL-1', stepId: 'st-3', kind: 'human' }),
    );
    await fixture.whenStable();
    expect(el.querySelector('.run-chip')?.textContent).toContain('approval');
    expect(el.querySelector('.run-chip')?.classList).toContain('waiting');

    events.emit(wireEvent('pipelineRunEnded', { cardId: 'T-1', pipelineId: 'PL-1', status: 'completed' }));
    await fixture.whenStable();
    expect(el.querySelector('.run-chip')).toBeNull();
  });

  it('renders the lock chip with blocker count when blocked', async () => {
    const el = (await render(card({ stage: 'new', blockedBy: ['T-9', 'T-10'] }), true))
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
