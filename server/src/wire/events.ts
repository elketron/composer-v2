// Canonical events — the server-originated records of state change
// (docs/architecture.md in v1; inherited verbatim where v2 keeps a domain).
// The wire eventType is the catalog name; the SSE frame body is the bare
// payload below. Event names are camelCase; enums are lowercase strings.

/**
 * The wire protocol version (S24): /health carries it, and the desktop's
 * gateway refuses any server whose answer doesn't match — a stale server
 * predating new commands can no longer be attached to silently (the S21
 * skew: unknown actions 400 for hours). Bump on every wire change (event
 * catalog or commands), together with the gateway's copy in
 * desktop/electron/server-registry.js.
 */
export const PROTOCOL_VERSION = 2;

import type {
  AgentSession,
  AgentSessionStatus,
  AssistantThread,
  AssistantThreadStatus,
  Assignee,
  Card,
  CardProposal,
  CardType,
  ChatMessage,
  Pipeline,
  PipelineRunStatus,
  PipelineStepKind,
  PlanningSession,
  Project,
  ProposalOutcome,
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

export interface ProjectArchived {
  projectId: string;
  archivedAt: string;
}

export interface ProjectRestored {
  projectId: string;
  restoredAt: string;
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

// ---- Global assistant (Phase 6): global events — no projectId; every
// frame reaches every subscriber and the fold owns a top-level slice. ----

export interface AssistantThreadCreated {
  thread: AssistantThread;
}

export interface AssistantThreadArchived {
  threadId: string;
  archivedAt: string;
}

export interface AssistantThreadRestored {
  threadId: string;
  restoredAt: string;
}

/** Replaces the thread's project scope wholesale. */
export interface AssistantThreadScopeChanged {
  threadId: string;
  projectIds: string[];
}

export interface AssistantUserMessage {
  threadId: string;
  message: ChatMessage;
}

export interface AssistantMessageDelta {
  threadId: string;
  messageIndex: number;
  delta: string;
}

export interface AssistantMessageComplete {
  threadId: string;
  message: ChatMessage;
}

// ---- Phase 7 conversation controls ----

/** The canonical stop record; the orchestrator aborts the in-flight turn. */
export interface AssistantThreadStopped {
  threadId: string;
}

/** The canonical retry record; the orchestrator re-runs the last user message. */
export interface AssistantRetryRequested {
  threadId: string;
}

/** The orchestrator's explicit status marks (failures; stops are canonical). */
export interface AssistantThreadStatusChanged {
  threadId: string;
  status: AssistantThreadStatus;
}

/** Replaces the thread's name. */
export interface AssistantThreadRenamed {
  threadId: string;
  name: string;
}

/**
 * Edit-and-resend (Phase 7): the edited user message opens a sibling
 * branch — its `parentId` matches the original's, so the prior branch
 * stays navigable and nothing in the transcript is rewritten.
 */
export interface AssistantResent {
  threadId: string;
  message: ChatMessage;
}

/**
 * The turn's tool activity (S25: the working box). The call event creates
 * the entry (the orchestrator caps nothing here — args are small); the
 * result event settles it with the output's capped head. Durable, like
 * the run view's agentToolCall/Result: the box survives reloads and past
 * turns stay inspectable. `parentId` is the user message the turn answers.
 */
export interface AssistantToolCall {
  threadId: string;
  parentId?: string;
  toolCallId: string;
  toolName: string;
  args?: unknown;
}

export interface AssistantToolResult {
  threadId: string;
  toolCallId: string;
  summary: string;
  isError: boolean;
}

// ---- Work proposals (Phase 8) ----

/** The assistant's draft; the creation event carries the full proposal. */
export interface ProposalDrafted {
  proposal: CardProposal;
}

/** Confirmation lands the (possibly edited) items and the batch outcomes. */
export interface ProposalConfirmed {
  proposalId: string;
  items: CardProposal['items'];
  outcomes: ProposalOutcome[];
  confirmedAt: string;
}

export interface ProposalDiscarded {
  proposalId: string;
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
  projectArchived: ProjectArchived;
  projectRestored: ProjectRestored;
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
  assistantThreadCreated: AssistantThreadCreated;
  assistantThreadArchived: AssistantThreadArchived;
  assistantThreadRestored: AssistantThreadRestored;
  assistantThreadScopeChanged: AssistantThreadScopeChanged;
  assistantUserMessage: AssistantUserMessage;
  assistantMessageDelta: AssistantMessageDelta;
  assistantMessageComplete: AssistantMessageComplete;
  assistantThreadStopped: AssistantThreadStopped;
  assistantRetryRequested: AssistantRetryRequested;
  assistantThreadStatusChanged: AssistantThreadStatusChanged;
  assistantThreadRenamed: AssistantThreadRenamed;
  assistantResent: AssistantResent;
  assistantToolCall: AssistantToolCall;
  assistantToolResult: AssistantToolResult;
  proposalDrafted: ProposalDrafted;
  proposalConfirmed: ProposalConfirmed;
  proposalDiscarded: ProposalDiscarded;
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
  projectArchived: null,
  projectRestored: null,
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
  assistantThreadCreated: null,
  assistantThreadArchived: null,
  assistantThreadRestored: null,
  assistantThreadScopeChanged: null,
  assistantUserMessage: null,
  assistantMessageDelta: null,
  assistantMessageComplete: null,
  assistantThreadStopped: null,
  assistantRetryRequested: null,
  assistantThreadStatusChanged: null,
  assistantThreadRenamed: null,
  assistantResent: null,
  assistantToolCall: null,
  assistantToolResult: null,
  proposalDrafted: null,
  proposalConfirmed: null,
  proposalDiscarded: null,
}) as EventName[];

/** Events that persist for the live stream but skip replay (v1 rule). */
export const EPHEMERAL: ReadonlySet<EventName> = new Set([
  'agentMessageDelta',
  'commandOutput',
  'assistantMessageDelta',
]);

/** Events published without a project scope (global domain state). */
export const GLOBAL_EVENTS: ReadonlySet<EventName> = new Set([
  'assistantThreadCreated',
  'assistantThreadArchived',
  'assistantThreadRestored',
  'assistantThreadScopeChanged',
  'assistantUserMessage',
  'assistantMessageDelta',
  'assistantMessageComplete',
  'assistantThreadStopped',
  'assistantRetryRequested',
  'assistantThreadStatusChanged',
  'assistantThreadRenamed',
  'assistantResent',
  'assistantToolCall',
  'assistantToolResult',
  'proposalDrafted',
  'proposalConfirmed',
  'proposalDiscarded',
]);

/** Whether an event name is in the catalog. */
export function isEventName(name: string): name is EventName {
  return (EVENT_NAMES as string[]).includes(name);
}
