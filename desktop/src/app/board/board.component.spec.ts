import { TestBed } from '@angular/core/testing';

import {
  FakeEventsClient,
  provideFakeEventsClient,
  seedCard,
  seedProject,
} from '../core/events/events-client.fake';
import { WireStage } from '../core/events/wire';
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
  });

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

  it('renders the type selector: all · coding · design · docs', async () => {
    const fixture = await render();
    expect(typeTabs(fixture.nativeElement)).toEqual(['all', 'coding', 'design', 'docs']);
  });

  it('defaults to the All swimlane with one row per type', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelectorAll('.swimlane .lane-row:not(.header-row)').length).toBe(3);
    // Header row offers the union of all lanes.
    expect(el.querySelectorAll('.header-row .col-label').length).toBe(9);
  });

  it('renders dimmed cells for inapplicable lanes (layout logic covered in board.models.spec)', async () => {
    const fixture = await render();
    const rows = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll('.swimlane .lane-row:not(.header-row)'),
    ];
    const dimmedCountPerRow = rows.map((row) => row.querySelectorAll('.cell.dimmed').length);
    expect(dimmedCountPerRow).toEqual([2, 3, 3]);
  });

  it('switches to the coding board with its seven lanes', async () => {
    const fixture = await render();
    await selectType(fixture, 'coding');
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('app-board-swimlane')).toBeNull();
    const labels = [...el.querySelectorAll('.column .header .label')].map((h) =>
      h.textContent!.trim(),
    );
    expect(labels).toEqual(['new', 'coding', 'validation', 'review', 'security', 'approval', 'done']);
  });

  it('switches to the design board without a security lane', async () => {
    const fixture = await render();
    await selectType(fixture, 'design');
    const labels = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll('.column .header .label'),
    ].map((h) => h.textContent!.trim());
    expect(labels).toEqual(['new', 'design', 'validation', 'review', 'approval', 'done']);
  });

  it('renders seeded cards in their lanes', async () => {
    seedCard(events, { id: 'T-1', title: 'Diff overlay', stage: WireStage.STAGE_CODING });
    seedCard(events, { id: 'T-2', title: 'Grammar cache' });
    const fixture = await render();
    await selectType(fixture, 'coding');
    const el = fixture.nativeElement as HTMLElement;
    const columns = [...el.querySelectorAll('.column')];

    const newColumn = columns[0];
    expect(newColumn.textContent).toContain('T-2');
    const codingColumn = columns[1];
    expect(codingColumn.textContent).toContain('T-1');
    expect(codingColumn.textContent).toContain('Diff overlay');
  });

  it('opens the card detail panel on card click and returns on back', async () => {
    seedCard(events, { id: 'T-2', title: 'Grammar cache' });
    const fixture = await render();
    await selectType(fixture, 'coding');
    const el = fixture.nativeElement as HTMLElement;

    el.querySelector<HTMLElement>('app-board-card')!.click();
    await fixture.whenStable();

    expect(el.querySelector('app-card-panel')).toBeTruthy();
    // The panel sits beside the board; the columns stay visible.
    expect(el.querySelector('.columns')).toBeTruthy();
    expect(el.textContent).toContain('T-2'); // first card of the new column

    el.querySelector<HTMLButtonElement>('.panel-header .back')!.click();
    await fixture.whenStable();

    expect(el.querySelector('app-card-panel')).toBeNull();
    expect(el.querySelector('.columns')).toBeTruthy();
  });

  it('shows the rejection comment bar after an approval -> implement-lane drag', async () => {
    seedCard(events, { id: 'T-1', stage: WireStage.STAGE_APPROVAL });
    const service = TestBed.inject(BoardService);
    const fixture = await render();

    await service.requestMove('T-1', 'coding');
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
          stage: 'new',
          blockedBy: [],
          subState: {},
          retries: {},
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
