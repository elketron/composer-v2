import { TestBed } from '@angular/core/testing';

import {
  FakeEventsClient,
  provideFakeEventsClient,
  seedCard,
  seedProject,
  wireEvent,
} from '../core/events/events-client.fake';
import { ShellService } from '../shell/shell.service';
import { BoardService } from '../board/board.service';
import { PipelineService } from '../pipelines/pipeline.service';
import { RunViewComponent } from './run-view.component';

describe('RunViewComponent', () => {
  let events: FakeEventsClient;

  beforeEach(async () => {
    events = new FakeEventsClient();
    await TestBed.configureTestingModule({
      imports: [RunViewComponent],
      providers: [provideFakeEventsClient(events)],
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
    local.emit(wireEvent('pipelineSaved', {
      pipeline: {
        id: 'PL-1',
        projectId: 'P-1',
        name: 'Standard coding card',
        steps: [
          { id: 'st-1', kind: 'agent', agentKind: 'coder', instructions: 'x' },
          { id: 'st-2', kind: 'command', command: 'npm test' },
        ],
      },
    }));
    local.emit(wireEvent('pipelineRunStarted', { cardId: 'T-1', pipelineId: 'PL-1' }));
    local.emit(wireEvent('pipelineStepStarted', { cardId: 'T-1', pipelineId: 'PL-1', stepId: 'st-1', kind: 'agent' }));
    local.emit(wireEvent('agentSessionStarted', { cardId: 'T-1', sessionId: 'A-1', agentKind: 'coder', startedAt: new Date().toISOString() }));
    local.emit(wireEvent('agentMessageComplete', { sessionId: 'A-1', message: { index: 1, role: 'agent', text: 'Reading the board code.', at: '' } }));
    local.emit(wireEvent('agentToolCall', { sessionId: 'A-1', toolCallId: 'c1', toolName: 'read', args: { path: 'board.ts' } }));
    local.emit(wireEvent('agentToolResult', { sessionId: 'A-1', toolCallId: 'c1', content: 'the file contents', isError: false }));
    local.emit(wireEvent('commandOutput', { cardId: 'T-1', pipelineId: 'PL-1', stepId: 'st-2', line: 'npm test' }));
  }

  async function render(cardId = 'T-1') {
    const fixture = TestBed.createComponent(RunViewComponent);
    fixture.componentRef.setInput('cardId', cardId);
    await fixture.whenStable();
    return fixture;
  }

  it('renders the three panes with the run header and transcript', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('.pane.output')).toBeTruthy();
    expect(el.querySelector('.pane.context')).toBeTruthy();
    expect(el.querySelector('.pane.build')).toBeTruthy();

    const head = el.querySelector('.run-head')?.textContent ?? '';
    expect(head).toContain('T-1');
    expect(head).toContain('Wire the debugger');
    expect(head).toContain('Standard coding card');
    expect(head).toContain('st-1');

    const output = el.querySelector('.pane.output')!.textContent!;
    expect(output).toContain('Reading the board code.');
    expect(output).toContain('read');
    expect(output).toContain('the file contents');

    expect(el.querySelector('.pane.build')!.textContent).toContain('npm test');
    expect(el.querySelector('.pane.context')!.textContent).toContain('todo');
  });

  it('stop publishes requestPipelineStop for the card', async () => {
    const fixture = await render();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.stop')!.click();
    await fixture.whenStable();

    expect(events.lastCommand('requestPipelineStop')).toMatchObject({
      requestPipelineStop: { cardId: 'T-1' },
    });
  });

  it('shows the outcome banner once the run is gone', async () => {
    events.emit(wireEvent('agentSessionEnded', { cardId: 'T-1', sessionId: 'A-1', status: 'failed', error: 'boom', endedAt: '' }));
    events.emit(wireEvent('pipelineRunEnded', { cardId: 'T-1', pipelineId: 'PL-1', status: 'failed', error: 'boom' }));
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;

    const pill = el.querySelector('.pill');
    expect(pill?.classList).toContain('failed');
    expect(pill?.textContent).toContain('the run failed — boom');
    // The transcript history stays readable.
    expect(el.querySelector('.pane.output')!.textContent).toContain('Reading the board code.');
    expect(el.querySelector('.stop')).toBeNull();
  });

  it('an unknown card shows the empty state', async () => {
    const fixture = await render('T-404');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('no card "T-404"');
  });
});
