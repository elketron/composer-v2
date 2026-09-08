// Domain records — the wire shapes (camelCase, RFC 3339 timestamps, absent
// optionals omitted). Phase 10 replaces the fixed worker-lane Stage enum with
// pipeline-local stages: every card is assigned to one pipeline, the board
// projects that pipeline's Kanban-visible stages, and runs are first-class
// records pinned to a pipeline revision (docs/phase-10-implementation.md).

export type CardType = 'coding' | 'design' | 'docs';

export type SubStateStatus = 'pending' | 'running' | 'ok' | 'failed';

export interface Assignee {
  role: string;
  model?: string;
  effort?: string;
}

export interface FileStats {
  added: number;
  removed: number;
  files: number;
}

export interface Card {
  id: string;
  projectId: string;
  type: CardType;
  title: string;
  description: string;
  tags: readonly string[];
  /** The one pipeline the card is assigned to; it appears on that pipeline's board tab. */
  pipelineId: string;
  /** The card's current stage of its assigned pipeline (may be a hidden stage). */
  stageId: string;
  blockedBy: readonly string[];
  assignee?: Assignee;
  sessionId?: string;
  branch?: string;
  fileStats?: FileStats;
  /** Per-step execution state, keyed by the assigned pipeline's step ids. */
  stepStates: Record<string, SubStateStatus>;
  rejectionComment?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  directory?: string;
  createdAt: string;
  archivedAt?: string;
}

/**
 * One markdown doc under the project's `docs/` directory (Phase 9). Files
 * are the truth; this metadata rides events and lists — content is read
 * over REST. `path` is slash-separated and relative to `docs/`.
 */
export interface DocInfo {
  path: string;
  title: string;
  size: number;
  updatedAt: string;
}

/**
 * One note in the global knowledge library (Phase 9): markdown with a
 * small frontmatter (title, tags) under the composer data dir. Files are
 * the truth; this metadata rides events and lists — content over REST.
 */
export interface KnowledgeEntryInfo {
  path: string;
  title: string;
  tags: string[];
  size: number;
  updatedAt: string;
}

/**
 * One step of a recorded agent workflow (S34): what to do, why, and the
 * command that does it — any one of the three may carry a step alone.
 */
export interface WorkflowStep {
  title: string;
  detail?: string;
  command?: string;
}

/**
 * One recorded agent workflow (S34): a stored procedure a worker agent
 * captured after doing a task, under the project's
 * `.composer/workflows/`. Files are the truth; this metadata rides events
 * and lists — content over REST. `source` is the card id the recording
 * came from; `agent` the agentKind that recorded it; `links` the docs,
 * knowledge notes, and cards the procedure draws on.
 */
export interface WorkflowInfo {
  path: string;
  title: string;
  description: string;
  tags: string[];
  source?: string;
  agent?: string;
  steps: number;
  links: string[];
  size: number;
  recordedAt?: string;
  updatedAt: string;
}

/**
 * One transcript message. Assistant-thread messages (Phase 7) carry a
 * stable `id` and the `parentId` they follow (absent = the thread root) —
 * edit-and-resend creates sibling branches; nothing is ever rewritten.
 * Planning-session messages predate ids and leave both absent.
 */
export interface ChatMessage {
  index: number;
  role: string;
  text: string;
  at?: string;
  id?: string;
  parentId?: string;
}

export type PlanningSessionStatus = 'drafting' | 'done';

export interface PlanningSession {
  id: string;
  projectId: string;
  createdAt: string;
  status: PlanningSessionStatus;
  messages: ChatMessage[];
  planDocument: string;
}

export type AgentSessionStatus = 'running' | 'ended' | 'failed';

// ---- Global assistant (Phase 6): threads are global domain state, not
// per-project — the scope is the thread's explicitly selected projects. ----

/** The thread's conversation state (Phase 7): a user message opens a turn,
 * the reply closes it; the orchestrator marks failures, stops are canonical. */
export type AssistantThreadStatus = 'idle' | 'running' | 'failed' | 'stopped';

/**
 * One tool call an assistant turn made (S25: the working box). The call
 * creates the entry; the result patches its summary in place. `parentId`
 * is the user message the turn answers — the transcript's turn grouping is
 * client-derived, like the branch tree.
 */
export interface AssistantToolEntry {
  toolCallId: string;
  parentId?: string;
  toolName: string;
  args?: unknown;
  /** The settled output's head (capped by the orchestrator). */
  summary?: string;
  isError?: boolean;
}

export interface AssistantThread {
  id: string;
  name: string;
  createdAt: string;
  /** Derived from the transcript: a user message opens a turn, the reply closes it. */
  status: AssistantThreadStatus;
  /** The explicitly selected active projects the thread may read. */
  projectIds: string[];
  archivedAt?: string;
  messages: ChatMessage[];
  /** The turns' tool activity, in arrival order (absent in pre-S25 logs). */
  toolCalls?: AssistantToolEntry[];
}

export type TranscriptEntry =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'toolCall'; toolCallId: string; toolName: string; args: unknown }
  | { kind: 'toolResult'; toolCallId: string; content: string; isError: boolean };

export interface AgentSession {
  id: string;
  projectId: string;
  cardId: string;
  status: AgentSessionStatus;
  startedAt: string;
  endedAt?: string;
  error?: string;
  transcript: TranscriptEntry[];
}

// ---- Pipelines (Phase 10): a pipeline owns an ordered stage path and an
// ordered step list; every step references one of its own stages. Only
// Kanban-visible stages become board columns. ----

export type PipelineStepKind = 'agent' | 'command' | 'human';

/**
 * One agent-reported named outcome and where it routes. An absent
 * `toStageId` proceeds to the next step; a present one must reference a
 * strictly earlier stage — the run ends `returned` and the task moves there.
 */
export interface StageOutcomeRule {
  outcome: string;
  toStageId?: string;
}

export interface PipelineStage {
  id: string;
  label: string;
  /** Whether the stage becomes a Kanban column (the first stage must). */
  kanbanVisible: boolean;
  /** The completion stage; exactly one per pipeline, and it must be last. */
  terminal?: boolean;
  /** The named outcomes an agent step in this stage may report (S36 enforces). */
  outcomes?: readonly StageOutcomeRule[];
  /** Agent steps in this stage must signal their outcome through the tool (S36). */
  requiresOutcome?: boolean;
  /** A failed step in this stage returns the task to this earlier stage (S35). */
  errorReturnToStageId?: string;
}

export interface PipelineStep {
  id: string;
  kind: PipelineStepKind;
  /** The stage of this pipeline the step works in (required). */
  stageId: string;
  agentKind?: string;
  instructions?: string;
  command?: string;
  description?: string;
}

export interface Pipeline {
  id: string;
  projectId: string;
  name: string;
  /** 1-based; a save that changes the definition allocates the next revision. */
  revision: number;
  /** The ordered stage path (index = forward order). */
  stages: readonly PipelineStage[];
  /** The ordered execution steps (each references one of its stages). */
  steps: readonly PipelineStep[];
  updatedAt: string;
}

export type PipelineRunStatus =
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | /** A backward transition (agent outcome or error condition) ended the run. */ 'returned'
  | 'cancelled';

/** Stage ids allocate `sg-N`, steps keep `st-N`, runs allocate `R-N`. */

// ---- Work proposals (Phase 8): the assistant drafts board-ready cards;
// the user edits and confirms; confirmation creates real cards through the
// validated processor as independent per-project batches. ----

export interface ProposalItem {
  id: string;
  /** The project the card lands in — must be in the drafting thread's scope. */
  projectId: string;
  title: string;
  description: string;
  cardType: CardType;
  /** Optional in-batch key other items' blockedBy can reference. */
  key?: string;
  /** Existing card ids of the target project or in-batch keys. */
  blockedBy: string[];
  /** The user's inclusion checkbox (default true). */
  included: boolean;
}

export type ProposalStatus = 'drafted' | 'confirmed' | 'discarded';

export interface ProposalOutcome {
  projectId: string;
  ok: boolean;
  cardIds?: string[];
  error?: string;
}

export interface CardProposal {
  id: string;
  threadId: string;
  createdAt: string;
  status: ProposalStatus;
  items: ProposalItem[];
  /** Set by confirmation (per-project batches). */
  outcomes?: ProposalOutcome[];
  confirmedAt?: string;
}

export function cardTypeCsName(type: CardType): string {
  return type === 'coding' ? 'Coding' : type === 'design' ? 'Design' : 'Docs';
}
