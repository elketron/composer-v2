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
  private readonly lastRunsByProject = signal<
    ReadonlyMap<string, ReadonlyMap<string, RunOutcome>>
  >(new Map());
  private readonly transcriptsByProject = signal<
    ReadonlyMap<string, ReadonlyMap<string, readonly RunTranscriptEntry[]>>
  >(new Map());
  private readonly commandOutputByProject = signal<
    ReadonlyMap<string, ReadonlyMap<string, readonly CommandOutputLine[]>>
  >(new Map());

  /** The last command rejection, for the views to surface (cleared on success). */
  readonly rejection = signal<string | null>(null);

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

  /** How each card's most recent run ended (the board's outcome projection). */
  readonly lastRuns = computed(
    () => this.lastRunsByProject().get(this.projectId() ?? '') ?? new Map<string, RunOutcome>(),
  );

  /** The run view's live transcript, per agent session id of the active project. */
  readonly transcripts = computed(
    () =>
      this.transcriptsByProject().get(this.projectId() ?? '') ??
      new Map<string, readonly RunTranscriptEntry[]>(),
  );

  /** The command steps' live output lines, per card id of the active project. */
  readonly commandOutput = computed(
    () =>
      this.commandOutputByProject().get(this.projectId() ?? '') ??
      new Map<string, readonly CommandOutputLine[]>(),
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

  /** How the card's most recent run ended (undefined = none this session). */
  lastRunForCard(cardId: string): RunOutcome | undefined {
    return this.lastRuns().get(cardId);
  }

  /** The live agent transcript for a session (the run view's output pane). */
  transcriptFor(sessionId: string | undefined): readonly RunTranscriptEntry[] {
    if (sessionId === undefined) return [];
    return this.transcripts().get(sessionId) ?? [];
  }

  /** The command steps' live output for a card (the run view's build pane). */
  commandOutputFor(cardId: string): readonly CommandOutputLine[] {
    return this.commandOutput().get(cardId) ?? [];
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
        // A fresh run starts with a clean build pane.
        this.commandOutputByProject.update((map) => {
          const cards = map.get(projectId);
          if (cards === undefined || !cards.has(payload.cardId)) return map;
          const nextCards = new Map(cards);
          nextCards.delete(payload.cardId);
          const next = new Map(map);
          next.set(projectId, nextCards);
          return next;
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
          ...(event.occurredAt ? { stepStartedAt: event.occurredAt } : {}),
        });
        break;
      }
      case 'pipelineRunEnded': {
        const payload = event.pipelineRunEnded;
        if (!payload?.cardId) break;
        const finished = this.runsByProject().get(projectId)?.get(payload.cardId);
        this.runsByProject.update((map) => {
          const runs = map.get(projectId);
          if (runs === undefined || !runs.has(payload.cardId)) return map;
          const nextRuns = new Map(runs);
          nextRuns.delete(payload.cardId);
          const next = new Map(map);
          next.set(projectId, nextRuns);
          return next;
        });
        this.lastRunsByProject.update((map) => {
          const outcome: RunOutcome = {
            status: payload.status === 'failed' ? 'failed' : 'completed',
            // The finished run's agent session — the transcript outlives the run.
            ...(finished?.sessionId ? { sessionId: finished.sessionId } : {}),
            ...(payload.error ? { error: payload.error } : {}),
          };
          const cardOutcomes = new Map(map.get(projectId) ?? []);
          cardOutcomes.set(payload.cardId, outcome);
          const next = new Map(map);
          next.set(projectId, cardOutcomes);
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
        // The run view keys its transcript on this session.
        const run = this.runsByProject().get(projectId)?.get(payload.cardId ?? '');
        if (run !== undefined && payload.cardId) {
          this.setRun(projectId, payload.cardId, {
            ...run,
            sessionId: payload.sessionId,
            ...(payload.startedAt ? { stepStartedAt: payload.startedAt } : {}),
          });
        }
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
      // The run view's live transcript: agent-step messages and tool calls
      // only (planning sessions fold in plan.service).
      case 'agentMessageDelta': {
        const payload = event.agentMessageDelta;
        if (!this.isAgentSession(projectId, payload?.sessionId)) break;
        this.appendToTranscript(projectId, payload!.sessionId, (entries) => {
          const last = entries.at(-1);
          if (last?.kind === 'message' && last.streaming) {
            const merged = { ...last, text: last.text + (payload?.delta ?? '') };
            return [...entries.slice(0, -1), merged];
          }
          return [
            ...entries,
            { kind: 'message', streaming: true, text: payload?.delta ?? '' } as RunTranscriptEntry,
          ];
        });
        break;
      }
      case 'agentMessageComplete': {
        const sessionId = event.agentMessageComplete?.sessionId;
        if (!this.isAgentSession(projectId, sessionId)) break;
        const text = event.agentMessageComplete?.message
          ? agentMessageText(event.agentMessageComplete.message)
          : '';
        this.appendToTranscript(projectId, sessionId!, (entries) => {
          // A streamed bubble finalizes; a cold complete (snapshot replay)
          // appends.
          const last = entries.at(-1);
          if (last?.kind === 'message' && last.streaming) {
            const final = { ...last, streaming: false, text: text || last.text };
            return [...entries.slice(0, -1), final];
          }
          return [...entries, { kind: 'message', streaming: false, text } as RunTranscriptEntry];
        });
        break;
      }
      case 'agentToolCall': {
        const payload = event.agentToolCall;
        if (!this.isAgentSession(projectId, payload?.sessionId)) break;
        this.appendToTranscript(projectId, payload!.sessionId, (entries) => [
          ...entries,
          {
            kind: 'tool',
            toolCallId: payload!.toolCallId,
            toolName: payload!.toolName ?? 'tool',
            args: payload!.args,
          } as RunTranscriptEntry,
        ]);
        break;
      }
      case 'agentToolResult': {
        const payload = event.agentToolResult;
        if (!this.isAgentSession(projectId, payload?.sessionId)) break;
        this.appendToTranscript(projectId, payload!.sessionId, (entries) => {
          let index = -1;
          for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];
            if (entry.kind === 'tool' && entry.toolCallId === payload!.toolCallId) {
              index = i;
              break;
            }
          }
          if (index < 0) return entries;
          const patched = {
            ...entries[index],
            result: { content: payload!.content ?? '', isError: payload!.isError ?? false },
          };
          return [...entries.slice(0, index), patched, ...entries.slice(index + 1)];
        });
        break;
      }
      case 'commandOutput': {
        const payload = event.commandOutput;
        if (!payload?.cardId || typeof payload.line !== 'string') break;
        this.commandOutputByProject.update((map) => {
          const cards = new Map(map.get(projectId) ?? []);
          const lines = [...(cards.get(payload.cardId) ?? []), { stepId: payload.stepId, line: payload.line }];
          cards.set(payload.cardId, lines.slice(-COMMAND_OUTPUT_CAP));
          const next = new Map(map);
          next.set(projectId, cards);
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

  /** True when the id is an agent session this service tracks (A-*). */
  private isAgentSession(projectId: string, sessionId: string | undefined): boolean {
    if (sessionId === undefined) return false;
    return this.sessionsByProject().get(projectId)?.some((s) => s.sessionId === sessionId) ?? false;
  }

  private appendToTranscript(
    projectId: string,
    sessionId: string,
    updater: (entries: readonly RunTranscriptEntry[]) => readonly RunTranscriptEntry[],
  ): void {
    this.transcriptsByProject.update((map) => {
      const sessions = new Map(map.get(projectId) ?? []);
      const entries = updater(sessions.get(sessionId) ?? []);
      sessions.set(sessionId, entries.slice(-TRANSCRIPT_CAP));
      const next = new Map(map);
      next.set(projectId, sessions);
      return next;
    });
  }

  private async publish(projectId: string, request: PublishRequest): Promise<boolean> {
    const response = await this.events.publish({ projectId, ...request });
    if (response.ok) {
      if (this.rejection() !== null) this.rejection.set(null);
      return true;
    }
    this.rejection.set(response.rejectionMessage ?? 'the server refused the request');
    return false;
  }
}

/** How a card's most recent pipeline run ended. */
export interface RunOutcome {
  readonly status: 'completed' | 'failed';
  /** The finished run's agent session (its transcript outlives the run). */
  readonly sessionId?: string;
  readonly error?: string;
}

export interface AgentSessionView {
  readonly sessionId: string;
  readonly cardId: string;
  readonly agentKind: string;
  readonly status: 'running' | 'ended' | 'failed';
  readonly startedAt: string;
  readonly error?: string;
}

/** One line of a command step's streamed output. */
export interface CommandOutputLine {
  readonly stepId: string;
  readonly line: string;
}

/** The run view's transcript: streamed messages interleaved with tool calls. */
export type RunTranscriptEntry =
  | {
      readonly kind: 'message';
      readonly messageId?: string;
      readonly streaming: boolean;
      readonly text: string;
    }
  | {
      readonly kind: 'tool';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args?: unknown;
      readonly result?: { readonly content: string; readonly isError: boolean };
    };

const COMMAND_OUTPUT_CAP = 400;
const TRANSCRIPT_CAP = 300;

function agentMessageText(message: unknown): string {
  const record = message as { text?: unknown } | undefined;
  return typeof record?.text === 'string' ? record.text : '';
}

type PublishRequest = {
  projectId?: string;
} & Partial<Pick<
  import('../core/events/wire').PublishRequestJson,
  'requestPipelineSave' | 'requestPipelineDelete' | 'requestPipelineRun' | 'requestPipelineStop' | 'requestPipelineGateRespond'
>>;
