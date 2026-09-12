import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { Router } from '@angular/router';

import {
  FakeEventsClient,
  provideFakeEventsClient,
  seedCard,
  seedProject,
  wireEvent,
} from '../core/events/events-client.fake';
import { RestClient } from '../core/rest';
import { ShellService } from '../shell/shell.service';
import { BoardService } from '../board/board.service';
import { PipelineService } from '../pipelines/pipeline.service';
import { DiffViewComponent } from './diff-view.component';

const A_TS_DIFF = [
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,3 +1,3 @@',
  ' line one',
  '-line two',
  '+CHANGED',
  ' line three',
].join('\n');

describe('DiffViewComponent', () => {
  let events: FakeEventsClient;
  let restCalls: string[];
  let restResponse: { ok: boolean; body: unknown } | null;

  beforeEach(async () => {
    events = new FakeEventsClient();
    restCalls = [];
    restResponse = null;
    await TestBed.configureTestingModule({
      imports: [DiffViewComponent],
      providers: [
        provideFakeEventsClient(events),
        {
          provide: RestClient,
          useValue: {
            get: (path: string) => {
              restCalls.push(path);
              return Promise.resolve(restResponse);
            },
          },
        },
      ],
    }).compileComponents();
    // Instantiate before seeding: folds only see events after subscription.
    TestBed.inject(ShellService);
    TestBed.inject(BoardService);
    TestBed.inject(PipelineService);
    seedProject(events, 'P-1');
    seedCard(events, { id: 'T-1', title: 'Wire the debugger' });
    seed(events);
  });

  function seed(local: FakeEventsClient): void {
    local.emit(wireEvent('agentSessionStarted', { cardId: 'T-1', sessionId: 'A-1', agentKind: 'coder', startedAt: new Date().toISOString() }));
    local.emit(
      wireEvent('agentSessionObserved', {
        sessionId: 'A-1',
        files: [{ path: 'a.ts', additions: 1, deletions: 1 }],
      }),
    );
  }

  async function render(cardId = 'T-1', file: string | null = 'a.ts') {
    const fixture = TestBed.createComponent(DiffViewComponent);
    fixture.componentRef.setInput('cardId', cardId);
    if (file !== null) fixture.componentRef.setInput('file', file);
    await fixture.whenStable();
    return fixture;
  }

  it('renders the fetched patch for the picked file', async () => {
    restResponse = { ok: true, body: { files: [{ path: 'a.ts', patch: A_TS_DIFF }] } };
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;

    const head = el.querySelector('.diff-head')!.textContent!;
    expect(head).toContain('a.ts');
    expect(head).toContain('read-only');
    expect(restCalls).toEqual(['/sessions/A-1/diff?projectId=P-1']);

    const diff = el.querySelector('.file-diff');
    expect(diff).not.toBeNull();
    expect(diff!.innerHTML).toContain('CHANGED');
  });

  it('shows the no-diff note when the endpoint has no patch', async () => {
    restResponse = { ok: true, body: { files: [] } };
    const fixture = await render();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('no working-tree diff for "a.ts"');
  });

  it('esc and the back button return to the run view', async () => {
    restResponse = { ok: true, body: { files: [{ path: 'a.ts', patch: A_TS_DIFF }] } };
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const fixture = await render();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await fixture.whenStable();
    expect(navigate).toHaveBeenCalledWith(['/projects', 'P-1', 'coding', 'run', 'T-1']);

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.back')!.click();
    await fixture.whenStable();
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it('without a picked file shows the empty state', async () => {
    const fixture = await render('T-1', null);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('no file picked');
    expect(restCalls).toEqual([]);
  });
});
