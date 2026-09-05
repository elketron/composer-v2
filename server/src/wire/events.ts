// Canonical events — the server-originated records of state change
// (docs/architecture.md in v1; inherited verbatim where v2 keeps a domain).
// The wire eventType is the catalog name; the SSE frame body is the bare
// payload below. Event names are camelCase; enums are lowercase strings.

import type {
  AgentSession,
  AgentSessionStatus,
  Assignee,
  Card,
  CardType,
  ChatMessage,
  Pipeline,
  PipelineRunStatus,
  PipelineStepKind,
  PlanningSession,
  Project,
  Stage,
  SubStateStatus,
} from './models.js';

export interface CardCreated {
  card: Card;
}

/** Comment is set when the move is an approval → implement-lane rejection. */
export interface CardMoved {
  cardId: string;
  from: Stage;
  to: Stage;
  comment?: string;
}

export interface CardTypeChanged {
  cardId: string;
  from: CardType;
  to: CardType;
}

/** Absent assignee = unassigned (the desktop's "unassign" action). */
export interface CardAssigned {
  cardId: string;
  assignee?: Assignee;
}

export interface CardArchived {
  cardId: string;
}

export interface SubStateUpdated {
  cardId: string;
  stage: string;
  status: SubStateStatus;
}

export interface DependencyStateChanged {
  cardId: string;
  blocked: boolean;
  blockedBy: string[];
}

export interface AutomationToggled {
  lane: Stage;
  on: boolean;
}

export interface PlanningSessionCreated {
  session: PlanningSession;
}

export interface UserMessageReceived {
  sessionId: string;
  message: ChatMessage;
}

export interface AgentMessageDelta {
  sessionId: string;
  messageIndex: number;
  delta: string;
}

export interface AgentMessageComplete {
  sessionId: string;
  message: ChatMessage;
}

/** Replaces the planning session's plan document wholesale. */
export interface PlanDocumentUpdated {
  sessionId: string;
  document: string;
}

/** The planning session's tickets have been emitted: the session is done. */
export interface PlanningSessionCompleted {
  sessionId: string;
}

export interface CardsCommitted {
  cards: Card[];
}

export interface ProjectCreated {
  project: Project;
}

export interface ProjectDirectoryChanged {
  projectId: string;
  directory: string;
}

export interface ProjectActivated {
  projectId: string;
}

export interface AgentSessionStarted {
  cardId: string;
  sessionId: string;
  agentKind: string;
  startedAt: string;
}

export interface AgentSessionEnded {
  cardId: string;
  sessionId: string;
  status: AgentSessionStatus;
  error?: string;
  endedAt: string;
}

export interface AgentToolCall {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface AgentToolResult {
  sessionId: string;
  toolCallId: string;
  content: string;
  isError: boolean;
}

export interface PipelineSaved {
  pipeline: Pipeline;
}

export interface PipelineDeleted {
  pipelineId: string;
}

/** The validated run command; the runner starts the execution. */
export interface PipelineRunStarted {
  cardId: string;
  pipelineId: string;
}

export interface PipelineStepStarted {
  cardId: string;
  pipelineId: string;
  stepId: string;
  kind: PipelineStepKind;
}

export interface PipelineStepFinished {
  cardId: string;
  pipelineId: string;
  stepId: string;
  ok: boolean;
  error?: string;
}

export interface PipelineRunEnded {
  cardId: string;
  pipelineId: string;
  status: PipelineRunStatus;
  error?: string;
}

/** A parked approval gate was answered; the run resumes. */
export interface PipelineGateResponded {
  cardId: string;
  approved: boolean;
  comment?: string;
}

/**
 * One line of a command step's live output. Live-only (ephemeral): the
 * durable record is the step's finish (ok/error tail), not the transcript.
 */
export interface CommandOutput {
  cardId: string;
  pipelineId: string;
  stepId: string;
  line: string;
}

// ---- The catalog: name → payload shape (the one registry both sides use) ----

export interface EventBodyMap {
  cardCreated: CardCreated;
  cardMoved: CardMoved;
  cardTypeChanged: CardTypeChanged;
  cardAssigned: CardAssigned;
  cardArchived: CardArchived;
  subStateUpdated: SubStateUpdated;
  dependencyStateChanged: DependencyStateChanged;
  automationToggled: AutomationToggled;
  planningSessionCreated: PlanningSessionCreated;
  userMessageReceived: UserMessageReceived;
  agentMessageDelta: AgentMessageDelta;
  agentMessageComplete: AgentMessageComplete;
  planDocumentUpdated: PlanDocumentUpdated;
  planningSessionCompleted: PlanningSessionCompleted;
  cardsCommitted: CardsCommitted;
  projectCreated: ProjectCreated;
  projectDirectoryChanged: ProjectDirectoryChanged;
  projectActivated: ProjectActivated;
  agentSessionStarted: AgentSessionStarted;
  agentSessionEnded: AgentSessionEnded;
  agentToolCall: AgentToolCall;
  agentToolResult: AgentToolResult;
  pipelineSaved: PipelineSaved;
  pipelineDeleted: PipelineDeleted;
  pipelineRunStarted: PipelineRunStarted;
  pipelineStepStarted: PipelineStepStarted;
  pipelineStepFinished: PipelineStepFinished;
  pipelineRunEnded: PipelineRunEnded;
  pipelineGateResponded: PipelineGateResponded;
  commandOutput: CommandOutput;
}

export type EventName = keyof EventBodyMap;
export type EventBody<N extends EventName = EventName> = EventBodyMap[N];

/** Every event name, in catalog order (the golden fixture's order). */
export const EVENT_NAMES = Object.keys({
  cardCreated: null,
  cardMoved: null,
  cardTypeChanged: null,
  cardAssigned: null,
  cardArchived: null,
  subStateUpdated: null,
  dependencyStateChanged: null,
  automationToggled: null,
  planningSessionCreated: null,
  userMessageReceived: null,
  agentMessageDelta: null,
  agentMessageComplete: null,
  planDocumentUpdated: null,
  planningSessionCompleted: null,
  cardsCommitted: null,
  projectCreated: null,
  projectDirectoryChanged: null,
  projectActivated: null,
  agentSessionStarted: null,
  agentSessionEnded: null,
  agentToolCall: null,
  agentToolResult: null,
  pipelineSaved: null,
  pipelineDeleted: null,
  pipelineRunStarted: null,
  pipelineStepStarted: null,
  pipelineStepFinished: null,
  pipelineRunEnded: null,
  pipelineGateResponded: null,
  commandOutput: null,
}) as EventName[];

/** Events that persist for the live stream but skip replay (v1 rule). */
export const EPHEMERAL: ReadonlySet<EventName> = new Set(['agentMessageDelta', 'commandOutput']);

/** Whether an event name is in the catalog. */
export function isEventName(name: string): name is EventName {
  return (EVENT_NAMES as string[]).includes(name);
}
