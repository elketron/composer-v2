// The current-state projection: a fold of every canonical event, per
// project keyed, idempotent (v1 architecture.md §Projection). Re-applying
// events yields the same state; the SSE snapshot is built from it.

import type { EventBodyMap, EventName } from './wire/events.js';
import type { EventEnvelope } from './wire/envelope.js';
import { isLaneValid, subStateFor } from './wire/models.js';
import type {
  ChatMessage,
  Pipeline,
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

export interface ProjectState {
  projectId: string;
  cards: Map<string, CardState>;
  automation: Map<Stage, boolean>;
  planningSessions: Map<string, PlanningSession>;
  agentSessions: Map<string, AgentSessionState>;
  pipelines: Map<string, Pipeline>;
  deletedPipelines: Set<string>;
  pipelineRuns: Map<string, PipelineRunProgress>;
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
      const session = projectStateOf(state, projectId).planningSessions.get(body.sessionId);
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
    default:
      // Domains not folded yet arrive in their slices; unknown names are
      // ignored so the fold is total over the catalog.
      break;
  }
}

/** Pipeline state accessors (unused before their slice; typed now). */
export type { Pipeline };
