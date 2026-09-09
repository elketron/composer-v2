// The fold's state shape: the per-project slices the fold builds and the
// global domains (assistant threads, proposals) beside them. Immutable
// domain instances (domain/card, domain/pipeline, domain/run, domain/
// project) hang off the maps; planning sessions, agent sessions, threads,
// and proposals join as their slices land.

import type { EventBodyMap, EventName } from '../wire/events.js';
import type { EventEnvelope } from '../wire/envelope.js';
import type {
  AssistantThread,
  CardProposal,
  ChatMessage,
  PlanningSession,
} from '../wire/models.js';
import { Card } from '../domain/card.js';
import { Pipeline } from '../domain/pipeline.js';
import { Project } from '../domain/project.js';
import { Run } from '../domain/run.js';

export interface ProjectState {
  projectId: string;
  cards: Map<string, Card>;
  /** Automation toggles per pipeline step: pipelineId → stepId → on. */
  automation: Map<string, Map<string, boolean>>;
  planningSessions: Map<string, PlanningSession>;
  agentSessions: Map<string, AgentSessionState>;
  /** Each pipeline's current definition (the highest folded revision). */
  pipelines: Map<string, Pipeline>;
  /** Every revision ever saved, for the runs that pinned them. */
  pipelineRevisions: Map<string, Map<number, Pipeline>>;
  deletedPipelines: Set<string>;
  /** Every run record, active and terminal (keyed by run id). */
  runs: Map<string, Run>;
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

/** A project's slice with no events folded: every map empty. */
export function emptyProjectState(projectId: string): ProjectState {
  return {
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
}

/** The project's slice, created empty on first touch. */
export function projectStateOf(state: State, projectId: string): ProjectState {
  let project = state.byProject.get(projectId);
  if (!project) {
    project = emptyProjectState(projectId);
    state.byProject.set(projectId, project);
  }
  return project;
}

/** One fold step: applies a single canonical event to the state. */
export type FoldHandler = (state: State, envelope: EventEnvelope, projectId: string) => void;

/** Reads an event body against the catalog. */
export function readBody<N extends EventName>(envelope: EventEnvelope, name: N): EventBodyMap[N] {
  return envelope.body as EventBodyMap[N];
}
