// The current-state projection: a fold of every canonical event, per
// project keyed, idempotent (v1 architecture.md §Projection). Re-applying
// events yields the same state; the SSE snapshot is built from it.
//
// Phase 10: cards carry their assigned pipeline and current stage, pipelines
// keep every revision (runs pin theirs), and runs are first-class records.

import type { EventBodyMap, EventName } from './wire/events.js';
import type { EventEnvelope } from './wire/envelope.js';
import type {
  AssistantThread,
  Card,
  CardProposal,
  ChatMessage,
  Pipeline,
  PipelineRunStatus,
  PipelineStepKind,
  PlanningSession,
  Project,
} from './wire/models.js';

/**
 * One pipeline run: an immutable attempt pinned to the pipeline revision it
 * started on. Active runs also carry their current position.
 */
export interface RunRecord {
  id: string;
  cardId: string;
  pipelineId: string;
  revision: number;
  status: PipelineRunStatus;
  startedAt: string;
  endedAt?: string;
  error?: string;
  stageId?: string;
  stepId?: string;
  stepKind?: PipelineStepKind;
}

export interface ProjectState {
  projectId: string;
  cards: Map<string, Card>;
  /** Automation toggles per pipeline stage: pipelineId → stageId → on. */
  automation: Map<string, Map<string, boolean>>;
  planningSessions: Map<string, PlanningSession>;
  agentSessions: Map<string, AgentSessionState>;
  /** Each pipeline's current definition (the highest folded revision). */
  pipelines: Map<string, Pipeline>;
  /** Every revision ever saved, for the runs that pinned them. */
  pipelineRevisions: Map<string, Map<number, Pipeline>>;
  deletedPipelines: Set<string>;
  /** Every run record, active and terminal (keyed by run id). */
  runs: Map<string, RunRecord>;
  /** The active run per card (at most one). */
  activeRuns: Map<string, string>;
}

export type TranscriptEntryState =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'toolCall'; toolCallId: string; toolName: string; args: unknown }
  | { kind: 'toolResult'; toolCallId: string; content: string; isError: boolean };

export interface AgentSessionState {
  id: string;
  projectId: string;
  cardId: string;
  /** The pipeline step's agent kind (the shipped agent the turn loads). */
  agentKind?: string;
  status: 'running' | 'ended' | 'failed';
  startedAt: string;
  endedAt?: string;
  error?: string;
  transcript: TranscriptEntryState[];
}

export interface State {
  projects: Map<string, Project>;
  byProject: Map<string, ProjectState>;
  /** Global assistant threads (Phase 6) — no projectId; the scope rides the thread. */
  assistantThreads: Map<string, AssistantThread>;
  /** The assistant's work proposals (Phase 8), keyed by proposal id. */
  proposals: Map<string, CardProposal>;
}

export function newState(): State {
  return {
    projects: new Map(),
    byProject: new Map(),
    assistantThreads: new Map(),
    proposals: new Map(),
  };
}

/** The card's visible Kanban column: the last visible stage at or before its stage. */
export function visibleStageOf(pipeline: Pipeline | undefined, stageId: string): string | undefined {
  if (pipeline === undefined) return undefined;
  const order = pipeline.stages.findIndex((stage) => stage.id === stageId);
  if (order < 0) return undefined;
  for (let index = order; index >= 0; index--) {
    const stage = pipeline.stages[index];
    if (stage?.kanbanVisible) return stage.id;
  }
  return undefined;
}

/** Whether a card sits in its pipeline's terminal (completion) stage. */
export function isTerminal(pipeline: Pipeline | undefined, card: Card): boolean {
  return pipeline?.stages.find((stage) => stage.id === card.stageId)?.terminal === true;
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
      pipelineRevisions: new Map(),
      deletedPipelines: new Set(),
      runs: new Map(),
      activeRuns: new Map(),
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
    case 'cardStageMoved': {
      const body = envelope.body as EventBodyMap['cardStageMoved'];
      const card = projectStateOf(state, projectId).cards.get(body.cardId);
      if (!card) break;
      card.stageId = body.toStageId;
      if (body.comment !== undefined) card.rejectionComment = body.comment;
      card.updatedAt = envelope.occurredAt;
      break;
    }
    case 'cardPipelineAssigned': {
      const body = envelope.body as EventBodyMap['cardPipelineAssigned'];
      const card = projectStateOf(state, projectId).cards.get(body.cardId);
      if (!card) break;
      card.pipelineId = body.pipelineId;
      card.stageId = body.stageId;
      card.updatedAt = envelope.occurredAt;
      break;
    }
    case 'cardTypeChanged': {
      const body = envelope.body as EventBodyMap['cardTypeChanged'];
      const card = projectStateOf(state, projectId).cards.get(body.cardId);
      if (!card) break;
      card.type = body.to;
      card.stepStates = {};
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
    case 'cardStepStateUpdated': {
      const body = envelope.body as EventBodyMap['cardStepStateUpdated'];
      const card = projectStateOf(state, projectId).cards.get(body.cardId);
      if (!card) break;
      card.stepStates[body.stepId] = body.status;
      card.updatedAt = envelope.occurredAt;
      break;
    }
    case 'dependencyStateChanged':
      // Derived state; clients fold blocked-ness from card data themselves.
      break;
    case 'automationToggled': {
      const body = envelope.body as EventBodyMap['automationToggled'];
      const project = projectStateOf(state, projectId);
      let stages = project.automation.get(body.pipelineId);
      if (!stages) {
        stages = new Map();
        project.automation.set(body.pipelineId, stages);
      }
      stages.set(body.stageId, body.on);
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
      const pipeline = structuredClone(body.pipeline);
      // Revisions may fold in any order across reconnects; the highest wins
      // as current, and every revision lands in the pinned history.
      const current = project.pipelines.get(pipeline.id);
      if (current === undefined || pipeline.revision >= current.revision) {
        project.pipelines.set(pipeline.id, pipeline);
      }
      let revisions = project.pipelineRevisions.get(pipeline.id);
      if (!revisions) {
        revisions = new Map();
        project.pipelineRevisions.set(pipeline.id, revisions);
      }
      revisions.set(pipeline.revision, pipeline);
      project.deletedPipelines.delete(pipeline.id);
      break;
    }
    case 'pipelineDeleted': {
      const body = envelope.body as EventBodyMap['pipelineDeleted'];
      const project = projectStateOf(state, projectId);
      project.pipelines.delete(body.pipelineId);
      // The tombstone keeps the boot seed from resurrecting the default.
      // The pinned revisions stay: historical runs keep theirs.
      project.deletedPipelines.add(body.pipelineId);
      break;
    }
    case 'pipelineRunStarted': {
      const body = envelope.body as EventBodyMap['pipelineRunStarted'];
      const project = projectStateOf(state, projectId);
      project.runs.set(body.runId, {
        id: body.runId,
        cardId: body.cardId,
        pipelineId: body.pipelineId,
        revision: body.revision,
        status: 'running',
        startedAt: envelope.occurredAt,
      });
      project.activeRuns.set(body.cardId, body.runId);
      break;
    }
    case 'pipelineStepStarted': {
      const body = envelope.body as EventBodyMap['pipelineStepStarted'];
      const project = projectStateOf(state, projectId);
      const run = runOf(project, body.runId, body.cardId);
      if (run) {
        run.stageId = body.stageId;
        run.stepId = body.stepId;
        run.stepKind = body.kind;
        // Only a gate waits; an agent or command step runs.
        run.status = body.kind === 'human' ? 'waiting' : 'running';
      }
      // The run owns stage transitions: the card follows the step's stage
      // (hidden stages project to the previous visible column client-side).
      const card = project.cards.get(body.cardId);
      if (card) {
        card.stageId = body.stageId;
        card.stepStates[body.stepId] = 'running';
        card.updatedAt = envelope.occurredAt;
      }
      break;
    }
    case 'pipelineStepFinished': {
      const body = envelope.body as EventBodyMap['pipelineStepFinished'];
      const project = projectStateOf(state, projectId);
      const run = runOf(project, body.runId, body.cardId);
      if (run && run.stepId === body.stepId) {
        if (body.error !== undefined) run.error = body.error;
      }
      const card = project.cards.get(body.cardId);
      if (card) {
        card.stepStates[body.stepId] = body.ok ? 'ok' : 'failed';
        card.updatedAt = envelope.occurredAt;
      }
      break;
    }
    case 'pipelineRunEnded': {
      const body = envelope.body as EventBodyMap['pipelineRunEnded'];
      const project = projectStateOf(state, projectId);
      const run = runOf(project, body.runId, body.cardId);
      if (run) {
        run.status = body.status;
        run.endedAt = envelope.occurredAt;
        if (body.error !== undefined) run.error = body.error;
        run.stepId = undefined;
        run.stepKind = undefined;
      }
      project.activeRuns.delete(body.cardId);
      break;
    }
    case 'pipelineGateResponded': {
      const body = envelope.body as EventBodyMap['pipelineGateResponded'];
      const project = projectStateOf(state, projectId);
      const run = runOf(project, body.runId, body.cardId);
      if (run && run.status === 'waiting') run.status = 'running';
      break;
    }

    // ---- Agent sessions (the workers' card-bound sessions) ----

    case 'agentSessionStarted': {
      const body = envelope.body as EventBodyMap['agentSessionStarted'];
      projectStateOf(state, projectId).agentSessions.set(body.sessionId, {
        id: body.sessionId,
        projectId,
        cardId: body.cardId,
        agentKind: body.agentKind,
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

    // ---- Global assistant (Phase 6): global events carry no projectId ----

    case 'assistantThreadCreated': {
      const body = envelope.body as EventBodyMap['assistantThreadCreated'];
      state.assistantThreads.set(body.thread.id, structuredClone(body.thread));
      break;
    }
    case 'assistantThreadArchived': {
      const body = envelope.body as EventBodyMap['assistantThreadArchived'];
      const thread = state.assistantThreads.get(body.threadId);
      if (thread) thread.archivedAt = body.archivedAt;
      break;
    }
    case 'assistantThreadRestored': {
      const body = envelope.body as EventBodyMap['assistantThreadRestored'];
      const thread = state.assistantThreads.get(body.threadId);
      if (thread) delete thread.archivedAt;
      break;
    }
    case 'assistantThreadScopeChanged': {
      const body = envelope.body as EventBodyMap['assistantThreadScopeChanged'];
      const thread = state.assistantThreads.get(body.threadId);
      if (thread) thread.projectIds = [...body.projectIds];
      break;
    }
    case 'assistantUserMessage':
    case 'assistantResent': {
      const body = envelope.body as EventBodyMap['assistantUserMessage' | 'assistantResent'];
      const thread = state.assistantThreads.get(body.threadId);
      if (!thread) break;
      foldThreadMessage(thread, body.message);
      // A user message opens the turn (the reply's completion closes it).
      thread.status = 'running';
      break;
    }
    case 'assistantMessageComplete': {
      const body = envelope.body as EventBodyMap['assistantMessageComplete'];
      const thread = state.assistantThreads.get(body.threadId);
      if (!thread) break;
      foldThreadMessage(thread, body.message);
      // The reply closes the turn — but never un-marks a stopped or failed
      // thread (the stop's partial completion and the failure message both
      // land through this event).
      if (thread.status === 'running') thread.status = 'idle';
      break;
    }
    case 'assistantThreadStopped': {
      const body = envelope.body as EventBodyMap['assistantThreadStopped'];
      const thread = state.assistantThreads.get(body.threadId);
      if (thread) thread.status = 'stopped';
      break;
    }
    case 'assistantRetryRequested': {
      const body = envelope.body as EventBodyMap['assistantRetryRequested'];
      const thread = state.assistantThreads.get(body.threadId);
      if (thread) thread.status = 'running';
      break;
    }
    case 'assistantThreadStatusChanged': {
      const body = envelope.body as EventBodyMap['assistantThreadStatusChanged'];
      const thread = state.assistantThreads.get(body.threadId);
      if (thread) thread.status = body.status;
      break;
    }
    case 'assistantThreadRenamed': {
      const body = envelope.body as EventBodyMap['assistantThreadRenamed'];
      const thread = state.assistantThreads.get(body.threadId);
      if (thread) thread.name = body.name;
      break;
    }
    case 'assistantToolCall': {
      // The working box (S25): the call creates the entry; idempotent by
      // toolCallId. Old logs' threads have no toolCalls — added here.
      const body = envelope.body as EventBodyMap['assistantToolCall'];
      const thread = state.assistantThreads.get(body.threadId);
      if (!thread) break;
      thread.toolCalls ??= [];
      if (!thread.toolCalls.some((entry) => entry.toolCallId === body.toolCallId)) {
        thread.toolCalls.push({
          toolCallId: body.toolCallId,
          ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
          toolName: body.toolName,
          ...(body.args !== undefined ? { args: structuredClone(body.args) } : {}),
        });
      }
      break;
    }
    case 'assistantToolResult': {
      const body = envelope.body as EventBodyMap['assistantToolResult'];
      const thread = state.assistantThreads.get(body.threadId);
      const entry = thread?.toolCalls?.find((tool) => tool.toolCallId === body.toolCallId);
      if (entry) {
        entry.summary = body.summary;
        entry.isError = body.isError;
      }
      break;
    }

    // ---- Work proposals (Phase 8) ----

    case 'proposalDrafted': {
      const body = envelope.body as EventBodyMap['proposalDrafted'];
      state.proposals.set(body.proposal.id, structuredClone(body.proposal));
      break;
    }
    case 'proposalConfirmed': {
      const body = envelope.body as EventBodyMap['proposalConfirmed'];
      const proposal = state.proposals.get(body.proposalId);
      if (!proposal) break;
      proposal.items = structuredClone(body.items);
      proposal.outcomes = structuredClone(body.outcomes);
      proposal.status = 'confirmed';
      proposal.confirmedAt = body.confirmedAt;
      break;
    }
    case 'proposalDiscarded': {
      const body = envelope.body as EventBodyMap['proposalDiscarded'];
      const proposal = state.proposals.get(body.proposalId);
      if (proposal) proposal.status = 'discarded';
      break;
    }
    default:
      // Domains not folded yet arrive in their slices; unknown names are
      // ignored so the fold is total over the catalog.
      break;
  }
}

/** The run a step/gate/end event belongs to: by runId, or the card's active run. */
function runOf(project: ProjectState, runId: string | undefined, cardId: string): RunRecord | undefined {
  if (runId !== undefined) return project.runs.get(runId);
  const active = project.activeRuns.get(cardId);
  return active !== undefined ? project.runs.get(active) : undefined;
}

/**
 * Folds one thread message. Message indexes are the transcript's order —
 * the command path allocates them outside the write lock, so a queued
 * message can race a queued reply onto the same index. A message never
 * steals a slot the opposite role already holds: the latecomer lands past
 * every folded message instead (re-applying the event finds its own slot
 * free, so the fold stays idempotent).
 */
function foldThreadMessage(thread: AssistantThread, incoming: ChatMessage): void {
  const occupant = thread.messages.find((existing) => existing.index === incoming.index);
  const message =
    occupant !== undefined && occupant.role !== incoming.role
      ? { ...incoming, index: nextThreadMessageIndex(thread) }
      : incoming;
  upsertThreadMessage(thread, message);
}

function upsertThreadMessage(thread: AssistantThread, message: ChatMessage): void {
  thread.messages = thread.messages
    .filter((existing) => existing.index !== message.index)
    .concat(structuredClone(message))
    .sort((a, b) => a.index - b.index);
}

function nextThreadMessageIndex(thread: AssistantThread): number {
  return thread.messages.reduce((max, message) => Math.max(max, message.index), 0) + 1;
}
