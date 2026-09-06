import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import {
  FakeEventsClient,
  provideFakeEventsClient,
  seedProject,
  wireEvent,
} from '../core/events/events-client.fake';
import { ConfirmService } from '../core/confirm/confirm.service';
import { DashboardComponent } from './dashboard.component';
import { DashboardService } from './dashboard.service';

describe('DashboardComponent', () => {
  let events: FakeEventsClient;

  beforeEach(async () => {
    events = new FakeEventsClient();
    await TestBed.configureTestingModule({
      imports: [DashboardComponent],
      providers: [provideFakeEventsClient(events), provideRouter([])],
    }).compileComponents();
  });

  it('shows every project from the startup snapshot', async () => {
    const fixture = TestBed.createComponent(DashboardComponent);
    seedProject(events, 'P-1', 'alpha');
    seedProject(events, 'P-2', 'beta');
    await fixture.whenStable();

    const cards = [...(fixture.nativeElement as HTMLElement).querySelectorAll('.project-card')];
    expect(cards.map((card) => card.textContent)).toEqual([
      expect.stringContaining('alpha'),
      expect.stringContaining('beta'),
    ]);
  });

  it('opens a project at its remembered coding view', async () => {
    const fixture = TestBed.createComponent(DashboardComponent);
    seedProject(events, 'P-1', 'alpha');
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    await fixture.whenStable();

    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('.project-open')?.click();

    expect(navigate).toHaveBeenCalledWith('/projects/P-1/coding/board');
  });

  it('shows Git and action-required health from the server projection', async () => {
    const fixture = TestBed.createComponent(DashboardComponent);
    seedProject(events, 'P-1', 'alpha');
    TestBed.inject(DashboardService).projects.set([
      {
        id: 'P-1',
        name: 'alpha',
        runningRuns: 1,
        waitingApprovals: [{ cardId: 'T-1', cardTitle: 'Review dashboard', pipelineId: 'PL-1' }],
        failedRuns: [],
        git: { status: 'dirty', branch: 'feature/dashboard' },
      },
    ]);
    await fixture.whenStable();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Action required');
    expect(text).toContain('Review dashboard');
    expect(text).toContain('feature/dashboard');
    expect(text).toContain('dirty');
    expect(text).toContain('1 running');
  });

  it('archives and restores a project from separate dashboard views', async () => {
    const fixture = TestBed.createComponent(DashboardComponent);
    seedProject(events, 'P-1', 'alpha');
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    el.querySelector<HTMLElement>('[aria-label="archive alpha"]')?.click();
    await fixture.whenStable();
    // The archive waits on the in-app confirmation dialog.
    expect(events.lastCommand('requestProjectArchive')).toBeUndefined();
    TestBed.inject(ConfirmService).resolve(true);
    await fixture.whenStable();
    expect(events.lastCommand('requestProjectArchive')?.requestProjectArchive).toEqual({
      projectId: 'P-1',
    });

    events.emit(
      wireEvent(
        'projectArchived',
        { projectId: 'P-1', archivedAt: new Date().toISOString() },
        'P-1',
      ),
    );
    await fixture.whenStable();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('.archive-toggle')?.click();
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Archived projects');

    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('[aria-label="restore alpha"]')?.click();
    await fixture.whenStable();
    expect(events.lastCommand('requestProjectRestore')?.requestProjectRestore).toEqual({
      projectId: 'P-1',
    });
  });
});
