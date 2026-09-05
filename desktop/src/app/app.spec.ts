import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import { BoardService } from './board/board.service';
import { App } from './app';
import { routes } from './app.routes';
import {
  FakeEventsClient,
  provideFakeEventsClient,
  wireCard,
  wireEvent,
} from './core/events/events-client.fake';
import { EVENTS_TRANSPORT, EventsTransport } from './core/events/events-client';
import { WireCardType, WireStage } from './core/events/wire';
import { PlanService } from './plan/plan.service';
import { ShellService } from './shell/shell.service';

const idleTransport: EventsTransport = {
  open: () => () => {},
  post: () => Promise.resolve({ ok: true }),
};

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter(routes), { provide: EVENTS_TRANSPORT, useValue: idleTransport }],
    }).compileComponents();
  });

  it('renders the shell: top bar, left rail, status strip', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('app-topbar')).toBeTruthy();
    expect(el.querySelector('app-left-rail')).toBeTruthy();
    expect(el.querySelector('app-status-strip')).toBeTruthy();
  });

  it('routes to the board view by default', async () => {
    const fixture = TestBed.createComponent(App);
    await TestBed.inject(Router).navigateByUrl('/');
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(TestBed.inject(Router).url).toBe('/board');
    expect(el.querySelector('app-board')).toBeTruthy();
  });
});

describe('restart snapshot folding', () => {
  it('restores projects, cards, planning state, and automation before live events', () => {
    const events = new FakeEventsClient();
    TestBed.configureTestingModule({ providers: [provideFakeEventsClient(events)] });
    const shell = TestBed.inject(ShellService);
    const board = TestBed.inject(BoardService);
    const plan = TestBed.inject(PlanService);
    const now = new Date().toISOString();

    events.emit(
      wireEvent('projectCreated', { project: { id: 'P-1', name: 'alpha', createdAt: now } }, 'P-1'),
    );
    events.emit(
      wireEvent('projectCreated', { project: { id: 'P-2', name: 'beta', createdAt: now } }, 'P-2'),
    );
    plan.setProject('P-1');
    // The snapshot re-delivers the persisted session: transcript and
    // plan document ride inside the PlanningSessionCreated body.
    events.emit(
      wireEvent(
        'planningSessionCreated',
        {
          session: {
            id: 'S-1',
            projectId: 'P-1',
            createdAt: now,
            status: 'drafting',
            messages: [
              { index: 1, role: 'user', text: 'plan', at: now },
              { index: 2, role: 'agent', text: 'ready', at: now },
            ],
            planDocument: '<plan>\n<goal>a board</goal>\n</plan>',
          },
        },
        'P-1',
      ),
    );
    events.emit(
      wireEvent(
        'cardCreated',
        {
          card: wireCard({
            id: 'T-1',
            projectId: 'P-1',
            type: WireCardType.CARD_TYPE_DESIGN,
            stage: WireStage.STAGE_REVIEW,
          }),
        },
        'P-1',
      ),
    );
    events.emit(
      wireEvent(
        'cardCreated',
        { card: wireCard({ id: 'T-2', projectId: 'P-1', blockedBy: ['T-1'] }) },
        'P-1',
      ),
    );
    events.emit(
      wireEvent(
        'automationToggled',
        { lane: WireStage.STAGE_SECURITY, on: false },
        'P-1',
      ),
    );
    TestBed.tick();

    expect(shell.tabs().map((tab) => tab.name)).toEqual(['alpha', 'beta']);
    expect(board.cards().map((card) => `${card.id}:${card.type}`)).toEqual([
      'T-1:design',
      'T-2:coding',
    ]);
    expect(board.blockedIds().has('T-2')).toBe(true);
    expect(board.automation().isOn('security')).toBe(false);
    expect(plan.messages().map((message) => `${message.role}:${message.index}`)).toEqual([
      'user:1',
      'agent:2',
    ]);
    expect(plan.status()).toBe('DRAFTING');
    expect(plan.planDocument()).toContain('a board');

    events.emit(
      wireEvent('cardMoved', { cardId: 'T-1', to: WireStage.STAGE_APPROVAL }, 'P-1'),
    );
    TestBed.tick();
    expect(board.cardsById().get('T-1')?.stage).toBe('approval');
  });
});
