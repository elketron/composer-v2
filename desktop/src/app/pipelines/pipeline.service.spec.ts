import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';

import { FakeEventsClient, provideFakeEventsClient } from '../core/events/events-client.fake';
import { DomainEventJson } from '../core/events/wire';
import { ShellService } from '../shell/shell.service';
import { Pipeline, PipelineStep } from '../core/models/pipeline.models';
import { PipelineService } from './pipeline.service';

describe('PipelineService', () => {
  let events: FakeEventsClient;

  const create = (): PipelineService => TestBed.inject(PipelineService);

  beforeEach(async () => {
    events = new FakeEventsClient();
    await TestBed.configureTestingModule({
      providers: [provideFakeEventsClient(events)],
    }).compileComponents();
  });

  /** The shell's tab list folds from projectCreated; create the tab, then activate it. */
  const activate = (projectId: string): void => {
    events.emit({
      id: `tab-${projectId}`,
      projectId,
      occurredAt: '',
      projectCreated: { project: { id: projectId, name: projectId, createdAt: '' } },
    });
    TestBed.inject(ShellService).activateTab(projectId);
  };

  const emit = (event: DomainEventJson): void => events.emit(event);

  const pipeline = (id: string, steps: PipelineStep[]): Pipeline =>
    new Pipeline({ id, name: 'Standard coding card', revision: 1, steps });

  const coderStep = PipelineStep.empty('st-1', 'agent').with({
    agentKind: 'coder',
    instructions: 'Implement the card.',
  });
  const gateStep = PipelineStep.empty('st-2', 'human').with({ description: 'Approval' });

  it('folds saved and deleted pipelines per project', async () => {
    const service = create();
    activate('P-1');
    expect(service.pipelines()).toEqual([]);

    emit({
      id: 'e1',
      projectId: 'P-1',
      occurredAt: '2026-09-05T00:00:00Z',
      pipelineSaved: {
        pipeline: {
          id: 'PL-1',
          projectId: 'P-1',
          name: 'Standard coding card',
          revision: 1,
          steps: [
            { id: 'st-1', kind: 'agent', boardVisible: true, agentKind: 'coder', instructions: 'Implement the card.' },
            { id: 'st-2', kind: 'human', boardVisible: true, description: 'Approval' },
            { id: 'st-3', kind: 'human', boardVisible: true, terminal: true },
          ],
          updatedAt: '2026-09-05T00:00:00Z',
        },
      },
    });
    expect(service.pipelines().map((p) => p.id)).toEqual(['PL-1']);
    expect(service.pipelines()[0]?.steps.map((s) => s.kind)).toEqual(['agent', 'human', 'human']);
    expect(service.pipelines()[0]?.terminalStepId).toBe('st-3');

    // An upsert replaces; a delete removes.
    emit({
      id: 'e2',
      projectId: 'P-1',
      occurredAt: '2026-09-05T00:00:01Z',
      pipelineSaved: {
        pipeline: {
          id: 'PL-1',
          projectId: 'P-1',
          name: 'Renamed',
          revision: 2,
          steps: [
            { id: 'st-1', kind: 'command', boardVisible: true, command: 'true' },
            { id: 'st-2', kind: 'human', boardVisible: true, terminal: true },
          ],
          updatedAt: '2026-09-05T00:00:01Z',
        },
      },
    });
    expect(service.pipelines()[0]?.name).toBe('Renamed');
    expect(service.pipelines()[0]?.revision).toBe(2);
    expect(service.pipelines()[0]?.steps).toHaveLength(2);

    // An older revision arriving late does not regress the current definition.
    emit({
      id: 'e3',
      projectId: 'P-1',
      occurredAt: '2026-09-05T00:00:02Z',
      pipelineSaved: {
        pipeline: {
          id: 'PL-1',
          projectId: 'P-1',
          name: 'Standard coding card',
          revision: 1,
          steps: [],
          updatedAt: '2026-09-05T00:00:00Z',
        },
      },
    });
    expect(service.pipelines()[0]?.name).toBe('Renamed');

    emit({
      id: 'e4',
      projectId: 'P-1',
      occurredAt: '2026-09-05T00:00:03Z',
      pipelineDeleted: { pipelineId: 'PL-1' },
    });
    expect(service.pipelines()).toEqual([]);
  });

  it('tracks a run through start, steps, gate and end', async () => {
    const service = create();
    activate('P-1');

    emit({
      id: 'e1',
      projectId: 'P-1',
      occurredAt: '',
      pipelineRunStarted: { runId: 'R-1', cardId: 'T-1', pipelineId: 'PL-1', revision: 2 },
    });
    expect(service.runForCard('T-1')).toEqual({
      runId: 'R-1',
      pipelineId: 'PL-1',
      revision: 2,
      status: 'running',
    });

    emit({
      id: 'e2',
      projectId: 'P-1',
      occurredAt: '',
      pipelineStepStarted: {
        runId: 'R-1',
        cardId: 'T-1',
        pipelineId: 'PL-1',
        stepId: 'st-1',
        kind: 'agent',
      },
    });
    expect(service.runForCard('T-1')).toMatchObject({
      stepId: 'st-1',
      stepKind: 'agent',
      status: 'running',
    });

    // A human step parks the run waiting.
    emit({
      id: 'e3',
      projectId: 'P-1',
      occurredAt: '',
      pipelineStepStarted: {
        runId: 'R-1',
        cardId: 'T-1',
        pipelineId: 'PL-1',
        stepId: 'st-2',
        kind: 'human',
      },
    });
    expect(service.runForCard('T-1')).toMatchObject({ stepId: 'st-2', stepKind: 'human', status: 'waiting' });

    // The run's end clears the progress and records the outcome.
    emit({
      id: 'e4',
      projectId: 'P-1',
      occurredAt: '',
      pipelineRunEnded: { runId: 'R-1', cardId: 'T-1', pipelineId: 'PL-1', revision: 2, status: 'returned', outcome: 'changes_requested', feedback: 'needs tests', routedToStepId: 'st-1' },
    });
    expect(service.runForCard('T-1')).toBeUndefined();
    expect(service.lastRunForCard('T-1')).toMatchObject({
      runId: 'R-1',
      status: 'returned',
      outcome: 'changes_requested',
      feedback: 'needs tests',
      routedToStepId: 'st-1',
    });
  });

  it('ignores step events for runs it does not track', () => {
    const service = create();
    activate('P-1');
    emit({
      id: 'e1',
      projectId: 'P-1',
      occurredAt: '',
      pipelineStepStarted: {
        runId: 'R-9',
        cardId: 'T-9',
        pipelineId: 'PL-1',
        stepId: 'st-1',
        kind: 'agent',
      },
    });
    expect(service.runForCard('T-9')).toBeUndefined();
  });

  it('lists agent sessions newest first and records their end', () => {
    const service = create();
    activate('P-1');

    emit({
      id: 'e1',
      projectId: 'P-1',
      occurredAt: '',
      agentSessionStarted: { cardId: 'T-1', sessionId: 'A-1', agentKind: 'coder', startedAt: '2026-09-05T00:00:00Z' },
    });
    emit({
      id: 'e2',
      projectId: 'P-1',
      occurredAt: '',
      agentSessionStarted: { cardId: 'T-2', sessionId: 'A-2', agentKind: 'coder', startedAt: '2026-09-05T00:00:01Z' },
    });
    expect(service.agentSessions().map((s) => s.sessionId)).toEqual(['A-2', 'A-1']);

    emit({
      id: 'e3',
      projectId: 'P-1',
      occurredAt: '',
      agentSessionEnded: { cardId: 'T-1', sessionId: 'A-1', status: 'failed', error: 'boom', endedAt: '' },
    });
    expect(service.agentSessions()[1]).toMatchObject({ sessionId: 'A-1', status: 'failed', error: 'boom' });
  });

  it('publishes the pipeline commands over the transport', async () => {
    const service = create();
    activate('P-1');

    await service.save('P-1', pipeline('PL-9', [coderStep, gateStep]));
    const saved = events.published.at(-1)!;
    expect(saved).toMatchObject({ projectId: 'P-1', requestPipelineSave: { pipeline: { id: 'PL-9', name: 'Standard coding card' } } });
    expect(saved.requestPipelineSave?.pipeline.steps).toEqual([
      { id: 'st-1', kind: 'agent', boardVisible: true, agentKind: 'coder', instructions: 'Implement the card.' },
      { id: 'st-2', kind: 'human', boardVisible: true, description: 'Approval' },
    ]);

    await service.remove('P-1', 'PL-9');
    expect(events.published.at(-1)).toMatchObject({ requestPipelineDelete: { pipelineId: 'PL-9' } });

    await service.run('T-1');
    expect(events.published.at(-1)).toMatchObject({ projectId: 'P-1', requestPipelineRun: { cardId: 'T-1' } });

    await service.stop('T-1');
    expect(events.published.at(-1)).toMatchObject({ requestPipelineStop: { cardId: 'T-1' } });

    await service.gateRespond('T-1', false, 'needs tests');
    expect(events.published.at(-1)).toMatchObject({
      requestPipelineGateRespond: { cardId: 'T-1', approved: false, comment: 'needs tests' },
    });

    // A rejection resolves false.
    events.respondWith({ ok: false, rejectionMessage: 'nope' });
    expect(await service.run('T-1')).toBe(false);
  });

  it('streams the run transcript and command output for the run view', () => {
    const service = create();
    activate('P-1');

    emit({ id: 'r1', projectId: 'P-1', occurredAt: '2026-09-05T00:00:00Z', pipelineRunStarted: { runId: 'R-1', cardId: 'T-1', pipelineId: 'PL-1', revision: 1 } });
    emit({ id: 'r2', projectId: 'P-1', occurredAt: '2026-09-05T00:00:01Z', agentSessionStarted: { cardId: 'T-1', sessionId: 'A-1', agentKind: 'coder', startedAt: '2026-09-05T00:00:01Z' } });
    emit({ id: 'r3', projectId: 'P-1', occurredAt: '2026-09-05T00:00:02Z', agentMessageDelta: { sessionId: 'A-1', messageIndex: 1, delta: 'working ' } });
    emit({ id: 'r4', projectId: 'P-1', occurredAt: '2026-09-05T00:00:03Z', agentMessageDelta: { sessionId: 'A-1', messageIndex: 1, delta: 'on it' } });
    emit({ id: 'r5', projectId: 'P-1', occurredAt: '2026-09-05T00:00:04Z', agentToolCall: { sessionId: 'A-1', toolCallId: 'c1', toolName: 'write', args: { path: 'src/x.ts' } } });
    emit({ id: 'r6', projectId: 'P-1', occurredAt: '2026-09-05T00:00:05Z', agentToolResult: { sessionId: 'A-1', toolCallId: 'c1', content: 'written', isError: false } });
    emit({ id: 'r7', projectId: 'P-1', occurredAt: '2026-09-05T00:00:06Z', agentMessageComplete: { sessionId: 'A-1', message: { index: 1, role: 'agent', text: 'working on it', at: '' } } });
    emit({ id: 'r8', projectId: 'P-1', occurredAt: '2026-09-05T00:00:07Z', commandOutput: { runId: 'R-1', cardId: 'T-1', pipelineId: 'PL-1', stepId: 'st-2', line: 'npm test' } });

    const transcript = service.transcriptFor('A-1');
    // The message completes in place across the intervening tool call — one
    // finalized message, not a stale streaming bubble plus a duplicate.
    expect(transcript).toHaveLength(2);
    expect(transcript[0]).toMatchObject({ kind: 'message', streaming: false, text: 'working on it', messageIndex: 1 });
    expect(transcript[1]).toMatchObject({ kind: 'tool', toolName: 'write' });
    const tool = transcript[1] as { kind: 'tool'; result?: { content: string } };
    expect(tool.result?.content).toBe('written');
    expect(service.runForCard('T-1')?.sessionId).toBe('A-1');
    expect(service.commandOutputFor('T-1')).toEqual([{ stepId: 'st-2', line: 'npm test' }]);

    // The run view keys nothing for unknown sessions (the planner's stream
    // is plan.service's).
    emit({ id: 'r9', projectId: 'P-1', occurredAt: '2026-09-05T00:00:08Z', agentMessageDelta: { sessionId: 'S-1', messageIndex: 1, delta: 'planning…' } });
    expect(service.transcriptFor('S-1')).toEqual([]);

    // A fresh run clears the build pane.
    emit({ id: 'r10', projectId: 'P-1', occurredAt: '2026-09-05T00:00:09Z', pipelineRunStarted: { runId: 'R-2', cardId: 'T-1', pipelineId: 'PL-1', revision: 1 } });
    expect(service.commandOutputFor('T-1')).toEqual([]);
  });
});