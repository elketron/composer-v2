import { TestBed } from '@angular/core/testing';

import {
  FakeEventsClient,
  provideFakeEventsClient,
  seedProject,
} from '../core/events/events-client.fake';
import { Lane } from '../core/models/board.models';
import { BoardService } from '../board/board.service';
import { StatusStripComponent } from './status-strip.component';

describe('StatusStripComponent', () => {
  let events: FakeEventsClient;

  beforeEach(async () => {
    events = new FakeEventsClient();
    await TestBed.configureTestingModule({
      imports: [StatusStripComponent],
      providers: [provideFakeEventsClient(events)],
    }).compileComponents();
    // Instantiate before seeding: folds only see events after subscription.
    TestBed.inject(BoardService);
    seedProject(events, 'P-1');
  });

  async function render() {
    const fixture = TestBed.createComponent(StatusStripComponent);
    await fixture.whenStable();
    return fixture;
  }

  it('shows one agent per enabled automation lane by default', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain(`${Lane.AGENT_OWNED.size} agents running`);
    expect(el.querySelectorAll('.agents .dot').length).toBe(Lane.AGENT_OWNED.size);
  });

  it('tracks automation toggles (mvp.md acceptance 13)', async () => {
    const service = TestBed.inject(BoardService);
    const fixture = await render();

    service.toggleAutomation('security');
    service.toggleAutomation('review');
    await fixture.whenStable();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain(`${Lane.AGENT_OWNED.size - 2} agents running`);
    expect(el.querySelectorAll('.agents .dot').length).toBe(Lane.AGENT_OWNED.size - 2);
  });
});
