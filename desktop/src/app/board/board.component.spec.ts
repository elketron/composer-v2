import { TestBed } from '@angular/core/testing';

import {
  FakeEventsClient,
  provideFakeEventsClient,
  seedCard,
  seedProject,
} from '../core/events/events-client.fake';
import { BoardComponent } from './board.component';
import { BoardService } from './board.service';

describe('BoardComponent', () => {
  let events: FakeEventsClient;

  beforeEach(async () => {
    events = new FakeEventsClient();
    await TestBed.configureTestingModule({
      imports: [BoardComponent],
      providers: [provideFakeEventsClient(events)],
    }).compileComponents();
    // Instantiate before seeding: folds only see events after subscription.
    TestBed.inject(BoardService);
    seedProject(events, 'P-1');
    seedPipeline('PL-1', 'Standard coding card');
  });

  /** The lane-path default pipeline the board tabs project. */
  function seedPipeline(id: string, name: string, projectId = 'P-1') {
    events.emit(
      {
        id: `e-${id}`,
        projectId,
        occurredAt: new Date().toISOString(),
        pipelineSaved: {
          pipeline: {
            id,
            projectId,
            name,
            revision: 1,
            updatedAt: new Date().toISOString(),
            lanes: [
              { id: 'ln-1', label: 'coder', kanbanVisible: true },
              { id: 'ln-2', label: 'Build', kanbanVisible: true },
              { id: 'ln-3', label: 'Test', kanbanVisible: true },
              { id: 'ln-4', label: 'approval', kanbanVisible: true },
              { id: 'ln-5', label: 'done', kanbanVisible: true, terminal: true },
            ],
            steps: [
              { id: 'st-1', kind: 'agent', laneId: 'ln-1', agentKind: 'coder', instructions: 'Implement.' },
              { id: 'st-2', kind: 'command', laneId: 'ln-2', command: 'npm run build', description: 'Build' },
              { id: 'st-3', kind: 'command', laneId: 'ln-3', command: 'npm test', description: 'Test' },
              { id: 'st-4', kind: 'human', laneId: 'ln-4', description: 'Approval' },
            ],
          },
        },
      } as never,
    );
  }

  async function render() {
    const fixture = TestBed.createComponent(BoardComponent);
    await fixture.whenStable();
    return fixture;
  }

  function typeTabs(el: HTMLElement): string[] {
    return [...el.querySelectorAll('.type-selector .option')].map((b) =>
      b.textContent!.trim().replace(/\s+/g, ' '),
    );
  }

  async function selectType(fixture: Awaited<ReturnType<typeof render>>, label: string) {
    const buttons = [...fixture.nativeElement.querySelectorAll('.type-selector .option')];
    const target = buttons.find((b) => (b as HTMLElement).textContent!.trim().includes(label))!;
    (target as HTMLElement).click();
    await fixture.whenStable();
  }

  function pipelineTabs(el: HTMLElement): string[] {
    return [...el.querySelectorAll('.pipeline-tab')].map((b) => b.textContent!.trim());
  }

  it('renders the type selector: all · coding · design · docs', async () => {
    const fixture = await render();
    expect(typeTabs(fixture.nativeElement)).toEqual(['all', 'coding', 'design', 'docs']);
  });

  it('renders one tab per pipeline, the first selected by default', async () => {
    seedPipeline('PL-2', 'Docs pass');
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;

    expect(pipelineTabs(el)).toEqual(['Standard coding card', 'Docs pass']);
    const active = [...el.querySelectorAll('.pipeline-tab')].find((b) =>
      b.classList.contains('active'),
    );
    expect(active?.textContent?.trim()).toBe('Standard coding card');
  });

  it('the tab selects the cards: only the assigned pipeline\'s cards render', async () => {
    seedPipeline('PL-2', 'Docs pass');
    seedCard(events, { id: 'T-1', title: 'Diff overlay', laneId: 'ln-2' });
    seedCard(events, { id: 'T-2', title: 'Docs card', pipelineId: 'PL-2', laneId: 'ln-1' });
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.textContent).toContain('T-1');
    expect(el.textContent).not.toContain('T-2');

    const tabs = [...el.querySelectorAll<HTMLButtonElement>('.pipeline-tab')];
    tabs.find((b) => b.textContent!.trim() === 'Docs pass')!.click();
    await fixture.whenStable();

    expect(el.textContent).toContain('T-2');
    expect(el.textContent).not.toContain('T-1');
  });

  it('the type selector filters the tab\'s cards instead of switching boards', async () => {
    seedCard(events, { id: 'T-1', title: 'Diff overlay', laneId: 'ln-2' });
    seedCard(events, { id: 'T-2', title: 'Spec doc', type: 'docs' });
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelectorAll('.board-column').length).toBe(5);
    expect(el.textContent).toContain('T-1');
    expect(el.textContent).toContain('T-2');

    await selectType(fixture, 'coding');
    expect(el.querySelectorAll('.board-column').length).toBe(5); // same board…
    expect(el.textContent).toContain('T-1');
    expect(el.textContent).not.toContain('T-2'); // …filtered to coding cards

    await selectType(fixture, 'all');
    expect(el.textContent).toContain('T-2');
  });

  it('renders seeded cards in their swimlane columns (hidden steps project back)', async () => {
    seedCard(events, { id: 'T-1', title: 'Diff overlay', laneId: 'ln-2' });
    seedCard(events, { id: 'T-2', title: 'Grammar cache' });
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    const columns = [...el.querySelectorAll('.board-column')];

    expect(columns[0].textContent).toContain('T-2');
    expect(columns[1].textContent).toContain('T-1');
    expect(columns[1].textContent).toContain('Diff overlay');
    const labels = [...el.querySelectorAll('.col-head .col-label')].map((h) => h.textContent!.trim());
    expect(labels).toEqual(['coder', 'Build', 'Test', 'approval', 'done']);
  });

  it('opens the card detail panel on card click and returns on back', async () => {
    seedCard(events, { id: 'T-2', title: 'Grammar cache' });
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;

    const card = el.querySelector<HTMLElement>('app-board-card')!;
    card.focus();
    card.click();
    await fixture.whenStable();

    expect(el.querySelector('app-card-panel')).toBeTruthy();
    // The panel sits beside the board; the columns stay visible.
    expect(el.querySelector('.columns')).toBeTruthy();
    expect(el.textContent).toContain('T-2');
    // Focus moved into the panel (the back button).
    expect(document.activeElement).toBe(el.querySelector('.panel-header .back'));

    el.querySelector<HTMLButtonElement>('.panel-header .back')!.click();
    await fixture.whenStable();

    expect(el.querySelector('app-card-panel')).toBeNull();
    expect(el.querySelector('.columns')).toBeTruthy();
    // Focus returned to the card that opened the panel.
    expect(document.activeElement).toBe(card);
  });

  it('shows the rejection comment bar after a drag out of the terminal step', async () => {
    seedCard(events, { id: 'T-1', laneId: 'ln-5' });
    const service = TestBed.inject(BoardService);
    const fixture = await render();

    await service.requestMove('T-1', 'ln-2');
    await fixture.whenStable();

    const el = fixture.nativeElement as HTMLElement;
    const bar = el.querySelector('.rejection-bar');
    expect(bar?.textContent).toContain('T-1');

    bar!.querySelector<HTMLButtonElement>('.action.subtle')!.click();
    await fixture.whenStable();
    expect(el.querySelector('.rejection-bar')).toBeNull();
  });

  it('creates a card from the new-card form and opens it in the panel', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;

    el.querySelector<HTMLButtonElement>('.new-card')!.click();
    await fixture.whenStable();
    const form = el.querySelector('app-card-creator');
    expect(form).toBeTruthy();

    const title = form!.querySelector<HTMLInputElement>('.title')!;
    title.value = 'Wire the debugger';
    title.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    form!.querySelector<HTMLButtonElement>('.create')!.click();
    await fixture.whenStable();

    // The command went out; the echo lands the card and opens its panel.
    expect(events.lastCommand('requestCardCreate')).toMatchObject({
      projectId: 'P-1',
      requestCardCreate: { title: 'Wire the debugger', type: 'coding' },
    });
    events.emit({
      id: 'e-card',
      projectId: 'P-1',
      occurredAt: new Date().toISOString(),
      cardCreated: {
        card: {
          id: 'T-9',
          projectId: 'P-1',
          type: 'coding',
          title: 'Wire the debugger',
          description: '',
          tags: [],
          pipelineId: 'PL-1',
          laneId: 'ln-1',
          blockedBy: [],
          stepStates: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    } as never);
    await fixture.whenStable();

    expect(el.querySelector('app-card-creator')).toBeNull();
    expect(el.querySelector('app-card-panel')).toBeTruthy();
    expect(el.textContent).toContain('T-9');
  });
});