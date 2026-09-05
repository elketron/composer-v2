import { TestBed } from '@angular/core/testing';

import {
  FakeEventsClient,
  provideFakeEventsClient,
  seedProject,
} from '../core/events/events-client.fake';
import { Lane, Stage } from '../core/models/board.models';
import { BoardColumnComponent } from './board-column.component';
import { BoardService } from './board.service';

describe('BoardColumnComponent', () => {
  let events: FakeEventsClient;

  beforeEach(async () => {
    events = new FakeEventsClient();
    await TestBed.configureTestingModule({
      imports: [BoardColumnComponent],
      providers: [provideFakeEventsClient(events)],
    }).compileComponents();
    // Instantiate the services before seeding: folds only see events that
    // arrive after subscription (same as the real stream).
    TestBed.inject(BoardService);
    // Automation toggles are scoped to a project; one must be active.
    seedProject(events, 'P-1');
  });

  async function render(lane: Stage) {
    const fixture = TestBed.createComponent(BoardColumnComponent);
    fixture.componentRef.setInput('lane', lane);
    fixture.componentRef.setInput('cards', []);
    fixture.componentRef.setInput('blockedIds', new Set<string>());
    await fixture.whenStable();
    return fixture;
  }

  it('shows an automation toggle on agent-owned lanes', async () => {
    const el = (await render('coding')).nativeElement as HTMLElement;
    const toggle = el.querySelector('.auto');
    expect(toggle?.textContent?.trim()).toBe('auto · on');
  });

  it('omits the toggle on human lanes', async () => {
    for (const lane of ['new', 'approval', 'done'] as const) {
      const el = (await render(lane)).nativeElement as HTMLElement;
      expect(el.querySelector('.auto')).toBeNull();
    }
  });

  it('flips the toggle label on click and back', async () => {
    const fixture = await render('validation');
    const el = fixture.nativeElement as HTMLElement;
    const toggle = el.querySelector<HTMLButtonElement>('.auto')!;

    toggle.click();
    await fixture.whenStable();
    expect(toggle.textContent?.trim()).toBe('auto · off');

    toggle.click();
    await fixture.whenStable();
    expect(toggle.textContent?.trim()).toBe('auto · on');
  });

  it('writes through to the board service automation state', async () => {
    const service = TestBed.inject(BoardService);
    const fixture = await render('review');

    el(fixture).querySelector<HTMLButtonElement>('.auto')!.click();
    await fixture.whenStable();

    expect(service.automation().isOn('review')).toBe(false);
    expect(service.automation().onCount).toBe(Lane.AGENT_OWNED.size - 1);
  });

  function el(fixture: Awaited<ReturnType<typeof render>>): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }
});
