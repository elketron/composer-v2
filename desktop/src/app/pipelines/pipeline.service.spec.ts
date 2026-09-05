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
    new Pipeline({ id, name: 'Standard coding card', steps });

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
          steps: [
            { id: 'st-1', kind: 'agent', agentKind: 'coder', instructions: 'Implement the card.' },
            { id: 'st-2', kind: 'human', description: 'Approval' },
          ],
          updatedAt: '2026-09-05T00:00:00Z',
        },
      },
    });
    expect(service.pipelines().map((p) => p.id)).toEqual(['PL-1']);
    expect(service.pipelines()[0]?.steps.map((s) => s.kind)).toEqual(['agent', 'human']);

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
          steps: [{ id: 'st-1', kind: 'command', command: 'true' }],
          updatedAt: '2026-09-05T00:00:01Z',
        },
      },
    });
    expect(service.pipelines()[0]?.name).toBe('Renamed');
    expect(service.pipelines()[0]?.steps).toHaveLength(1);

    emit({
      id: 'e3',
      projectId: 'P-1',
      occurredAt: '2026-09-05T00:00:02Z',
      pipelineDeleted: { pipelineId: 'PL-1' },
    });
    expect(service.pipelines()).toEqual([]);
  });

  it('tracks a run through start, steps, gate and end', async () => {
    const service = create();
    activate('P-1');

    emit({ id: 'e1', projectId: 'P-1', occurredAt: '', pipelineRunStarted: { cardId: 'T-1', pipelineId: 'PL-1' } });
    expect(service.runForCard('T-1')).toEqual({ pipelineId: 'PL-1', status: 'running' });

    emit({
      id: 'e2',
      projectId: 'P-1',
      occurredAt: '',
      pipelineStepStarted: { cardId: 'T-1', pipelineId: 'PL-1', stepId: 'st-1', kind: 'agent' },
    });
    expect(service.runForCard('T-1')).toMatchObject({ stepId: 'st-1', stepKind: 'agent', status: 'running' });

    // A human step parks the run waiting.
    emit({
      id: 'e3',
      projectId: 'P-1',
      occurredAt: '',
      pipelineStepStarted: { cardId: 'T-1', pipelineId: 'PL-1', stepId: 'st-2', kind: 'human' },
    });
    expect(service.runForCard('T-1')).toMatchObject({ stepId: 'st-2', stepKind: 'human', status: 'waiting' });

    // The run's end clears the progress.
    emit({
      id: 'e4',
      projectId: 'P-1',
      occurredAt: '',
      pipelineRunEnded: { cardId: 'T-1', pipelineId: 'PL-1', status: 'completed' },
    });
    expect(service.runForCard('T-1')).toBeUndefined();
  });

  it('ignores step events for runs it does not track', () => {
    const service = create();
    activate('P-1');
    emit({
      id: 'e1',
      projectId: 'P-1',
      occurredAt: '',
      pipelineStepStarted: { cardId: 'T-9', pipelineId: 'PL-1', stepId: 'st-1', kind: 'agent' },
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
    expect(events.published.at(-1)).toMatchObject({
      projectId: 'P-1',
      requestPipelineSave: {
        pipeline: {
          id: 'PL-9',
          name: 'Standard coding card',
          steps: [
            { id: 'st-1', kind: 'agent', agentKind: 'coder', instructions: 'Implement the card.' },
            { id: 'st-2', kind: 'human', description: 'Approval' },
          ],
        },
      },
    });

    await service.remove('P-1', 'PL-9');
    expect(events.published.at(-1)).toMatchObject({ requestPipelineDelete: { pipelineId: 'PL-9' } });

    await service.run('PL-1', 'T-1');
    expect(events.published.at(-1)).toMatchObject({ projectId: 'P-1', requestPipelineRun: { pipelineId: 'PL-1', cardId: 'T-1' } });

    await service.stop('T-1');
    expect(events.published.at(-1)).toMatchObject({ requestPipelineStop: { cardId: 'T-1' } });

    await service.gateRespond('T-1', false, 'needs tests');
    expect(events.published.at(-1)).toMatchObject({
      requestPipelineGateRespond: { cardId: 'T-1', approved: false, comment: 'needs tests' },
    });

    // A rejection resolves false.
    events.respondWith({ ok: false, rejectionMessage: 'nope' });
    expect(await service.run('PL-1', 'T-1')).toBe(false);
  });
});
