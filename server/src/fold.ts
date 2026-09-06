// The current-state projection: a fold of every canonical event, per
// project keyed, idempotent (v1 architecture.md §Projection). Re-applying
// events yields the same state; the SSE snapshot is built from it.

import type { EventBodyMap, EventName } from './wire/events.js';
import type { EventEnvelope } from './wire/envelope.js';
import { isLaneValid, subStateFor } from './wire/models.js';
import type {
  ChatMessage,
  Pipeline,
  PipelineRunStatus,
  PlanningSession,
  Project,
  Stage,
} from './wire/models.js';

/** Where a card's pipeline run is (keyed by card id, one per card). */
export interface PipelineRunProgress {
  pipelineId: string;
  status: 'running' | 'waiting';
  stepId?: string;
  stepKind?: 'agent' | 'command' | 'human';
}

export interface LatestPipelineRun {
  pipelineId: string;
  status: PipelineRunStatus;
  startedAt: string;
  endedAt?: string;
  error?: string;
}

export interface ProjectState {
  projectId: string;
  cards: Map<string, CardState>;
  automation: Map<Stage, boolean>;
  planningSessions: Map<string, PlanningSession>;
  agentSessions: Map<string, AgentSessionState>;
  pipelines: Map<string, Pipeline>;
  deletedPipelines: Set<string>;
  pipelineRuns: Map<string, PipelineRunProgress>;
  latestRuns: Map<string, LatestPipelineRun>;
}

export type TranscriptEntryState =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'toolCall'; toolCallId: string; toolName: string; args: unknown }
  | { kind: 'toolResult'; toolCallId: string; content: string; isError: boolean };

export interface AgentSessionState {
  id: string;
  projectId: string;
  cardId: string;
  status: 'running' | 'ended' | 'failed';
  startedAt: string;
  endedAt?: string;
  error?: string;
  transcript: TranscriptEntryState[];
}

export interface CardState {
  id: string;
  projectId: string;
  type: 'coding' | 'design' | 'docs';
  title: string;
  description: string;
  tags: string[];
  stage: Stage;
  blockedBy: string[];
  assignee?: { role: string; model?: string; effort?: string };
  sessionId?: string;
  branch?: string;
  fileStats?: { added: number; removed: number; files: number };
  subState: Record<string, 'pending' | 'running' | 'ok' | 'failed'>;
  retries: Record<string, number>;
  rejectionComment?: string;
  createdAt: string;
  updatedAt: string;
}

export interface State {
  projects: Map<string, Project>;
  byProject: Map<string, ProjectState>;
}

export function newState(): State {
  return { projects: new Map(), byProject: new Map() };
}

/** The card sub-state stage a pipeline step kind works in (v1, M3). */
export function stepStageOf(kind: 'agent' | 'command' | 'human'): string {
  switch (kind) {
    case 'agent':
      return 'implement';
    case 'command':
      return 'runValidation';
    case 'human':
      return 'humanReview';
  }
}

function projectStateOf(state: State, projectId: string): ProjectState {
  let project = state.byProject.get(projectId);
  if (!project) {
    project = {
      projectId,
      cards: new Map(),
      automation: new Map(),
      planningSessions: new Map(),
      agentSessions: new Map(),
      pipelines: new Map(),
      deletedPipelines: new Set(),
      pipelineRuns: new Map(),
      latestRuns: new Map(),
    };
    state.byProject.set(projectId, project);
  }
  return project;
}

/**
 * Folds one canonical event into state. Idempotent: re-applying an event
 * changes nothing (S0 folds the project domain; cards, planning, agent
 * sessions, and pipelines join in their slices).
 */
export function apply(state: State, envelope: EventEnvelope): void {
  const name = envelope.name as EventName;
  const projectId = envelope.projectId ?? '';

  switch (name) {
    case 'projectCreated': {
      const body = envelope.body as EventBodyMap['projectCreated'];
      state.projects.set(body.project.id, structuredClone(body.project));
      projectStateOf(state, body.project.id);
      break;
    }
    case 'projectDirectoryChanged': {
      const body = envelope.body as EventBodyMap['projectDirectoryChanged'];
      const project = state.projects.get(body.projectId);
      if (project) project.directory = body.directory;
      break;
    }
    case 'projectActivated': {
      // Active tab is UI state; the event exists for other subscribers.
      break;
    }
    case 'projectArchived': {
      const body = envelope.body as EventBodyMap['projectArchived'];
      const project = state.projects.get(body.projectId);
      if (project) project.archivedAt = body.archivedAt;
      break;
    }
    case 'projectRestored': {
      const body = envelope.body as EventBodyMap['projectRestored'];
      const project = state.projects.get(body.projectId);
      if (project) delete project.archivedAt;
      break;
    }
    case 'cardCreated': {
      const body = envelope.body as EventBodyMap['cardCreated'];
      const cards = projectStateOf(state, projectId).cards;
      cards.set(body.card.id, structuredClone(body.card));
      break;
    }
    case 'cardMoved': {
      const body = envelope.body as EventBodyMap['cardMoved'];
      const card = projectStateOf(state, projectId).cards.get(body.cardId);
      if (!card) break;
      card.stage = body.to;
      // Dragging to New unassigns (v1 design.md §3.4).
      if (body.to === 'new') card.assignee = undefined;
      // The move's comment is the rejection comment of an approval →
      // implement-lane drag; every move carries it (possibly empty).
      if (body.comment !== undefined) card.rejectionComment = body.comment;
      card.updatedAt = envelope.occurredAt;
      break;
    }
    case 'cardTypeChanged': {
      const body = envelope.body as EventBodyMap['cardTypeChanged'];
      const card = projectStateOf(state, projectId).cards.get(body.cardId);
      if (!card) break;
      card.type = body.to;
      card.subState = subStateFor(body.to);
      if (!isLaneValid(body.to, card.stage)) card.stage = 'new';
      card.updatedAt = envelope.occurredAt;
      break;
    }
    case 'cardAssigned': {
      const body = envelope.body as EventBodyMap['cardAssigned'];
      const card = projectStateOf(state, projectId).cards.get(body.cardId);
      if (!card) break;
      card.assignee = body.assignee;
      card.updatedAt = envelope.occurredAt;
      break;
    }
    case 'cardArchived': {
      const body = envelope.body as EventBodyMap['cardArchived'];
      projectStateOf(state, projectId).cards.delete(body.cardId);
      break;
    }
    case 'subStateUpdated': {
      const body = envelope.body as EventBodyMap['subStateUpdated'];
      const card = projectStateOf(state, projectId).cards.get(body.cardId);
      if (!card) break;
      card.subState[body.stage] = body.status;
      card.updatedAt = envelope.occurredAt;
      break;
    }
    case 'dependencyStateChanged':
      // Derived state; clients fold blocked-ness from card data themselves.
      break;
    case 'automationToggled': {
      const body = envelope.body as EventBodyMap['automationToggled'];
      projectStateOf(state, projectId).automation.set(body.lane as Stage, body.on);
      break;
    }

    // ---- Planning ----

    case 'planningSessionCreated': {
      const body = envelope.body as EventBodyMap['planningSessionCreated'];
      projectStateOf(state, projectId).planningSessions.set(
        body.session.id,
        structuredClone(body.session),
      );
      break;
    }
    case 'userMessageReceived':
    case 'agentMessageComplete': {
      const body = envelope.body as EventBodyMap['userMessageReceived' | 'agentMessageComplete'];
      const project = projectStateOf(state, projectId);
      // An agent session's id claims the message first (the coder's
      // transcript); planning sessions share the event type (v1 rule).
      const agentSession = project.agentSessions.get(body.sessionId);
      if (agentSession !== undefined) {
        agentSession.transcript = agentSession.transcript
          .filter((entry) => !(entry.kind === 'message' && entry.message.index === body.message.index))
          .concat({ kind: 'message', message: structuredClone(body.message) });
        break;
      }
      const session = project.planningSessions.get(body.sessionId);
      if (!session) break;
      session.messages = session.messages
        .filter((message) => message.index !== body.message.index)
        .concat(structuredClone(body.message))
        .sort((a, b) => a.index - b.index);
      break;
    }
    case 'planDocumentUpdated': {
      const body = envelope.body as EventBodyMap['planDocumentUpdated'];
      const session = projectStateOf(state, projectId).planningSessions.get(body.sessionId);
      if (session) session.planDocument = body.document;
      break;
    }
    case 'planningSessionCompleted': {
      const body = envelope.body as EventBodyMap['planningSessionCompleted'];
      const session = projectStateOf(state, projectId).planningSessions.get(body.sessionId);
      if (session) session.status = 'done';
      break;
    }
    case 'cardsCommitted': {
      const body = envelope.body as EventBodyMap['cardsCommitted'];
      const cards = projectStateOf(state, projectId).cards;
      for (const card of body.cards) {
        cards.set(card.id, structuredClone(card));
      }
      break;
    }

    // ---- Pipelines ----

    case 'pipelineSaved': {
      const body = envelope.body as EventBodyMap['pipelineSaved'];
      const project = projectStateOf(state, projectId);
      project.pipelines.set(body.pipeline.id, structuredClone(body.pipeline));
      project.deletedPipelines.delete(body.pipeline.id);
      break;
    }
    case 'pipelineDeleted': {
      const body = envelope.body as EventBodyMap['pipelineDeleted'];
      const project = projectStateOf(state, projectId);
      project.pipelines.delete(body.pipelineId);
      // The tombstone keeps the boot seed from resurrecting the default.
      project.deletedPipelines.add(body.pipelineId);
      break;
    }
    case 'pipelineRunStarted': {
      const body = envelope.body as EventBodyMap['pipelineRunStarted'];
      const project = projectStateOf(state, projectId);
      project.pipelineRuns.set(body.cardId, {
        pipelineId: body.pipelineId,
        status: 'running',
      });
      project.latestRuns.set(body.cardId, {
        pipelineId: body.pipelineId,
        status: 'running',
        startedAt: envelope.occurredAt,
      });
      break;
    }
    case 'pipelineStepStarted': {
      const body = envelope.body as EventBodyMap['pipelineStepStarted'];
      const run = projectStateOf(state, projectId).pipelineRuns.get(body.cardId);
      if (!run) break;
      run.stepId = body.stepId;
      run.stepKind = body.kind;
      // Only a gate waits; an agent or command step runs.
      run.status = body.kind === 'human' ? 'waiting' : 'running';
      const latest = projectStateOf(state, projectId).latestRuns.get(body.cardId);
      if (latest) latest.status = run.status;
      break;
    }
    case 'pipelineStepFinished': {
      const body = envelope.body as EventBodyMap['pipelineStepFinished'];
      const project = projectStateOf(state, projectId);
      if (body.ok) break;
      const card = project.cards.get(body.cardId);
      if (!card) break;
      // Every failed attempt is recorded on the card's retries, keyed by
      // the stage the step works in (v1 fold, M3).
      const kind = project.pipelineRuns.get(body.cardId)?.stepKind ?? 'agent';
      const stage = stepStageOf(kind);
      card.retries[stage] = (card.retries[stage] ?? 0) + 1;
      card.updatedAt = envelope.occurredAt;
      break;
    }
    case 'pipelineRunEnded': {
      const body = envelope.body as EventBodyMap['pipelineRunEnded'];
      const project = projectStateOf(state, projectId);
      const previous = project.latestRuns.get(body.cardId);
      project.latestRuns.set(body.cardId, {
        pipelineId: body.pipelineId,
        status: body.status,
        startedAt: previous?.startedAt ?? envelope.occurredAt,
        endedAt: envelope.occurredAt,
        ...(body.error !== undefined ? { error: body.error } : {}),
      });
      project.pipelineRuns.delete(body.cardId);
      break;
    }
    case 'pipelineGateResponded': {
      const body = envelope.body as EventBodyMap['pipelineGateResponded'];
      const run = projectStateOf(state, projectId).pipelineRuns.get(body.cardId);
      if (run) run.status = 'running';
      const latest = projectStateOf(state, projectId).latestRuns.get(body.cardId);
      if (latest) latest.status = 'running';
      break;
    }

    // ---- Agent sessions (the coder's card-bound sessions) ----

    case 'agentSessionStarted': {
      const body = envelope.body as EventBodyMap['agentSessionStarted'];
      projectStateOf(state, projectId).agentSessions.set(body.sessionId, {
        id: body.sessionId,
        projectId,
        cardId: body.cardId,
        status: 'running',
        startedAt: body.startedAt,
        transcript: [],
      });
      break;
    }
    case 'agentSessionEnded': {
      const body = envelope.body as EventBodyMap['agentSessionEnded'];
      const session = projectStateOf(state, projectId).agentSessions.get(body.sessionId);
      if (!session) break;
      session.status = body.status;
      session.endedAt = body.endedAt;
      if (body.error !== undefined) session.error = body.error;
      break;
    }
    case 'agentToolCall': {
      const body = envelope.body as EventBodyMap['agentToolCall'];
      const session = projectStateOf(state, projectId).agentSessions.get(body.sessionId);
      if (!session) break;
      session.transcript.push({
        kind: 'toolCall',
        toolCallId: body.toolCallId,
        toolName: body.toolName,
        args: body.args,
      });
      break;
    }
    case 'agentToolResult': {
      const body = envelope.body as EventBodyMap['agentToolResult'];
      const session = projectStateOf(state, projectId).agentSessions.get(body.sessionId);
      if (!session) break;
      session.transcript.push({
        kind: 'toolResult',
        toolCallId: body.toolCallId,
        content: body.content,
        isError: body.isError,
      });
      break;
    }
    default:
      // Domains not folded yet arrive in their slices; unknown names are
      // ignored so the fold is total over the catalog.
      break;
  }
}

/** Pipeline state accessors (unused before their slice; typed now). */
export type { Pipeline };
