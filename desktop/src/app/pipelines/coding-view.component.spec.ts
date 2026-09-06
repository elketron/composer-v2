import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import {
  FakeEventsClient,
  provideFakeEventsClient,
  seedProject,
  wireEvent,
} from '../core/events/events-client.fake';
import { PipelineService } from './pipeline.service';
import { CodingViewComponent } from './coding-view.component';

describe('CodingViewComponent', () => {
  let events: FakeEventsClient;

  beforeEach(async () => {
    events = new FakeEventsClient();
    await TestBed.configureTestingModule({
      imports: [CodingViewComponent],
      providers: [provideFakeEventsClient(events), provideRouter([])],
    }).compileComponents();
    // Instantiate the folding service before seeding: folds only see
    // events after subscription.
    TestBed.inject(PipelineService);
    seedProject(events, 'P-1', 'alpha');
  });

  it('is empty before any agent session ran', async () => {
    const fixture = TestBed.createComponent(CodingViewComponent);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'no agent sessions yet',
    );
  });

  it('lists sessions newest first with status and failure detail', async () => {
    events.emit(
      wireEvent('agentSessionStarted', { cardId: 'T-1', sessionId: 'A-1', agentKind: 'coder', startedAt: new Date().toISOString() }, 'P-1'),
    );
    events.emit(
      wireEvent('agentSessionStarted', { cardId: 'T-2', sessionId: 'A-2', agentKind: 'coder', startedAt: new Date().toISOString() }, 'P-1'),
    );
    events.emit(
      wireEvent('agentSessionEnded', { cardId: 'T-1', sessionId: 'A-1', status: 'failed', error: 'the agent step failed', endedAt: '' }, 'P-1'),
    );

    const fixture = TestBed.createComponent(CodingViewComponent);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    const rows = [...el.querySelectorAll('.row')];
    expect(rows.map((row) => row.querySelector('.session-id')?.textContent)).toEqual([
      'A-2',
      'A-1',
    ]);

    const failed = rows[1]!;
    expect(failed.classList).toContain('failed');
    expect(failed.textContent).toContain('the agent step failed');
  });

  it('links a card session to its run view and leaves cardless ones inert', async () => {
    events.emit(
      wireEvent('agentSessionStarted', { cardId: 'T-1', sessionId: 'A-1', agentKind: 'coder', startedAt: new Date().toISOString() }, 'P-1'),
    );
    events.emit(
      wireEvent('agentSessionStarted', { cardId: '', sessionId: 'A-2', agentKind: 'planner', startedAt: new Date().toISOString() }, 'P-1'),
    );

    const fixture = TestBed.createComponent(CodingViewComponent);
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    const rows = [...el.querySelectorAll<HTMLAnchorElement>('a.row, article.row')];
    expect(rows).toHaveLength(2);

    // A-2 (no card) is newest, so it sorts first and renders inert.
    const linked = el.querySelector<HTMLAnchorElement>('a.row')!;
    expect(linked.textContent).toContain('A-1');
    linked.click();
    await fixture.whenStable();
    // routerLink passes navigation extras as a second argument.
    expect(navigate).toHaveBeenCalledWith(
      router.parseUrl('/projects/P-1/coding/run/T-1'),
      expect.anything(),
    );

    expect(el.querySelector('article.row')?.textContent).toContain('A-2');
  });
});
