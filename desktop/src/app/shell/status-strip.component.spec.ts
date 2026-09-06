import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import {
  FakeEventsClient,
  provideFakeEventsClient,
  seedProject,
  wireEvent,
} from '../core/events/events-client.fake';
import { PipelineService } from '../pipelines/pipeline.service';
import { StatusStripComponent } from './status-strip.component';

describe('StatusStripComponent', () => {
  let events: FakeEventsClient;

  beforeEach(async () => {
    events = new FakeEventsClient();
    await TestBed.configureTestingModule({
      imports: [StatusStripComponent],
      providers: [provideFakeEventsClient(events), provideRouter([])],
    }).compileComponents();
    // Instantiate before seeding: folds only see events after subscription.
    TestBed.inject(PipelineService);
    seedProject(events, 'P-1');
  });

  async function render() {
    const fixture = TestBed.createComponent(StatusStripComponent);
    await fixture.whenStable();
    return fixture;
  }

  function startSession(sessionId: string): void {
    events.emit(
      wireEvent('agentSessionStarted', {
        sessionId,
        cardId: 'T-1',
        agentKind: 'coder',
        startedAt: new Date().toISOString(),
      }),
    );
  }

  it('hides the agents block while nothing runs', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.agents')).toBeNull();
  });

  it('counts actually running agent sessions', async () => {
    const fixture = await render();
    startSession('A-1');
    startSession('A-2');
    await fixture.whenStable();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('2 agents running');
    expect(el.querySelectorAll('.agents .dot').length).toBe(2);
  });

  it('singularizes the label for one session', async () => {
    const fixture = await render();
    startSession('A-1');
    await fixture.whenStable();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('1 agent running');
  });

  it('drops a session once it ends', async () => {
    const fixture = await render();
    startSession('A-1');
    await fixture.whenStable();
    events.emit(
      wireEvent('agentSessionEnded', {
        sessionId: 'A-1',
        cardId: 'T-1',
        status: 'ended',
        endedAt: new Date().toISOString(),
      }),
    );
    await fixture.whenStable();

    expect((fixture.nativeElement as HTMLElement).querySelector('.agents')).toBeNull();
  });

  it('shows the model without project-only hints on a global route', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).not.toContain('tab');
    expect(el.textContent).not.toContain('ctrl+k');
  });
});
