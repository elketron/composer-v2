import { Injectable, computed, inject, signal } from '@angular/core';

import { EventsClient } from '../core/events/events-client';
import {
  DomainEventJson,
  PipelineJson,
  domainEventKind,
} from '../core/events/wire';
import {
  Pipeline,
  PipelineStep,
  RunProgress,
} from '../core/models/pipeline.models';
import { ShellService } from '../shell/shell.service';

/**
 * Pipelines and their runs: a fold of the event stream (PipelineSaved,
 * PipelineDeleted, PipelineRunStarted/StepStarted/StepFinished/RunEnded,
 * PipelineGateResponded) plus the agent sessions agent steps open
 * (AgentSessionStarted/Ended). Commands publish over the same transport —
 * the server validates; a rejection is returned to the caller (the editor
 * shows it).
 */
@Injectable({ providedIn: 'root' })
export class PipelineService {
  private static readonly SEEN_IDS_CAP = 4096;

  private readonly events = inject(EventsClient);
  private readonly shell = inject(ShellService);

  private readonly pipelinesByProject = signal<ReadonlyMap<string, readonly Pipeline[]>>(
    new Map(),
  );
  private readonly runsByProject = signal<ReadonlyMap<string, ReadonlyMap<string, RunProgress>>>(
    new Map(),
  );
  private readonly sessionsByProject = signal<ReadonlyMap<string, readonly AgentSessionView[]>>(
    new Map(),
  );

  private readonly projectId = computed(() => this.shell.activeTabId());

  readonly pipelines = computed(
    () => this.pipelinesByProject().get(this.projectId() ?? '') ?? [],
  );

  /** Run progress per card of the active project (the board's projection). */
  readonly runs = computed(
    () => this.runsByProject().get(this.projectId() ?? '') ?? new Map<string, RunProgress>(),
  );

  /** The agent sessions of the active project, newest first (the coding tab). */
  readonly agentSessions = computed(
    () => this.sessionsByProject().get(this.projectId() ?? '') ?? [],
  );

  private readonly seenEventIds = new Map<string, true>();

  constructor() {
    this.events.events$.subscribe((event) => this.fold(event));
  }

  // ---- Commands (publish; the server validates) ----

  save(projectId: string, pipeline: Pipeline): Promise<boolean> {
    return this.publish(projectId, { requestPipelineSave: { pipeline: pipeline.toWire() } });
  }

  remove(projectId: string, pipelineId: string): Promise<boolean> {
    return this.publish(projectId, { requestPipelineDelete: { pipelineId } });
  }

  run(pipelineId: string, cardId: string): Promise<boolean> {
    return this.publish(this.projectId() ?? '', { requestPipelineRun: { pipelineId, cardId } });
  }

  stop(cardId: string): Promise<boolean> {
    return this.publish(this.projectId() ?? '', { requestPipelineStop: { cardId } });
  }

  gateRespond(cardId: string, approved: boolean, comment?: string): Promise<boolean> {
    return this.publish(this.projectId() ?? '', {
      requestPipelineGateRespond: {
        cardId,
        approved,
        ...(comment ? { comment } : {}),
      },
    });
  }

  // ---- Selectors ----

  runForCard(cardId: string): RunProgress | undefined {
    return this.runs().get(cardId);
  }

  pipelineById(id: string): Pipeline | undefined {
    return this.pipelines().find((pipeline) => pipeline.id === id);
  }

  // ---- Event fold (stream → signals; idempotent) ----

  private fold(event: DomainEventJson): void {
    if (event.id) {
      if (this.seenEventIds.has(event.id)) return;
      this.seenEventIds.set(event.id, true);
      if (this.seenEventIds.size > PipelineService.SEEN_IDS_CAP) {
        const oldest = this.seenEventIds.keys().next().value;
        if (oldest !== undefined) this.seenEventIds.delete(oldest);
      }
    }
    const projectId = event.projectId ?? '';
    switch (domainEventKind(event)) {
      case 'pipelineSaved': {
        const json = event.pipelineSaved?.pipeline as PipelineJson | undefined;
        if (!json?.id) break;
        const pipeline = Pipeline.fromWire(json);
        this.pipelinesByProject.update((map) => {
          const pipelines = (map.get(projectId) ?? []).filter((p) => p.id !== pipeline.id);
          const next = new Map(map);
          next.set(projectId, [...pipelines, pipeline]);
          return next;
        });
        break;
      }
      case 'pipelineDeleted': {
        const pipelineId = event.pipelineDeleted?.pipelineId;
        if (!pipelineId) break;
        this.pipelinesByProject.update((map) => {
          const pipelines = (map.get(projectId) ?? []).filter((p) => p.id !== pipelineId);
          const next = new Map(map);
          next.set(projectId, pipelines);
          return next;
        });
        break;
      }
      case 'pipelineRunStarted': {
        const payload = event.pipelineRunStarted;
        if (!payload?.cardId) break;
        this.setRun(projectId, payload.cardId, {
          pipelineId: payload.pipelineId ?? '',
          status: 'running',
        });
        break;
      }
      case 'pipelineStepStarted': {
        const payload = event.pipelineStepStarted;
        if (!payload?.cardId) break;
        const current = this.runsByProject().get(projectId)?.get(payload.cardId);
        if (current === undefined) break;
        this.setRun(projectId, payload.cardId, {
          ...current,
          stepId: payload.stepId,
          stepKind: payload.kind ?? 'agent',
          status: payload.kind === 'human' ? 'waiting' : 'running',
        });
        break;
      }
      case 'pipelineRunEnded': {
        const payload = event.pipelineRunEnded;
        if (!payload?.cardId) break;
        this.runsByProject.update((map) => {
          const runs = map.get(projectId);
          if (runs === undefined || !runs.has(payload.cardId)) return map;
          const nextRuns = new Map(runs);
          nextRuns.delete(payload.cardId);
          const next = new Map(map);
          next.set(projectId, nextRuns);
          return next;
        });
        break;
      }
      case 'agentSessionStarted': {
        const payload = event.agentSessionStarted;
        if (!payload?.sessionId) break;
        this.sessionsByProject.update((map) => {
          const sessions = map.get(projectId) ?? [];
          const next = new Map(map);
          next.set(projectId, [
            {
              sessionId: payload.sessionId,
              cardId: payload.cardId ?? '',
              agentKind: payload.agentKind ?? 'coder',
              status: 'running',
              startedAt: payload.startedAt ?? '',
            },
            ...sessions.filter((session) => session.sessionId !== payload.sessionId),
          ]);
          return next;
        });
        break;
      }
      case 'agentSessionEnded': {
        const payload = event.agentSessionEnded;
        if (!payload?.sessionId) break;
        this.sessionsByProject.update((map) => {
          const sessions = map.get(projectId) ?? [];
          const next = new Map(map);
          next.set(
            projectId,
            sessions.map((session) =>
              session.sessionId === payload.sessionId
                ? { ...session, status: payload.status ?? 'ended', error: payload.error }
                : session,
            ),
          );
          return next;
        });
        break;
      }
      // pipelineStepFinished: the outcome rides the step's sub-state and
      // the card's retries (the board folds those); gate responses flip
      // the run back to running, which the next step's start re-sets.
    }
  }

  private setRun(projectId: string, cardId: string, progress: RunProgress): void {
    this.runsByProject.update((map) => {
      const runs = new Map(map.get(projectId) ?? []);
      runs.set(cardId, progress);
      const next = new Map(map);
      next.set(projectId, runs);
      return next;
    });
  }

  private async publish(projectId: string, request: PublishRequest): Promise<boolean> {
    const response = await this.events.publish({ projectId, ...request });
    return response.ok;
  }
}

export interface AgentSessionView {
  readonly sessionId: string;
  readonly cardId: string;
  readonly agentKind: string;
  readonly status: 'running' | 'ended' | 'failed';
  readonly startedAt: string;
  readonly error?: string;
}

type PublishRequest = {
  projectId?: string;
} & Partial<Pick<
  import('../core/events/wire').PublishRequestJson,
  'requestPipelineSave' | 'requestPipelineDelete' | 'requestPipelineRun' | 'requestPipelineStop' | 'requestPipelineGateRespond'
>>;
