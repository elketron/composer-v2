// Domain records — the wire shapes (camelCase, RFC 3339 timestamps, absent
// optionals omitted). Ported from v1's serde models with the v2 trims: the
// workflow-recording domain and the dormant agent-session commands are gone;
// everything the board, the planning turn, and the pipelines use keeps its
// v1 shape so the desktop folds unchanged.

export type CardType = 'coding' | 'design' | 'docs';

export type Stage =
  | 'new'
  | 'coding'
  | 'design'
  | 'docs'
  | 'validation'
  | 'review'
  | 'security'
  | 'approval'
  | 'done';

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
  tags: string[];
  stage: Stage;
  blockedBy: string[];
  assignee?: Assignee;
  sessionId?: string;
  branch?: string;
  fileStats?: FileStats;
  subState: Record<string, SubStateStatus>;
  retries: Record<string, number>;
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

export type PipelineStepKind = 'agent' | 'command' | 'human';

export interface PipelineStep {
  id: string;
  kind: PipelineStepKind;
  agentKind?: string;
  instructions?: string;
  command?: string;
  description?: string;
  retries?: number;
}

export interface Pipeline {
  id: string;
  projectId: string;
  name: string;
  steps: PipelineStep[];
  updatedAt: string;
}

export type PipelineRunStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

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

// ---- Lane semantics (v1 design.md §3.1) ----

export const ALL_STAGES: Stage[] = [
  'new',
  'coding',
  'design',
  'docs',
  'validation',
  'review',
  'security',
  'approval',
  'done',
];

export const AGENT_OWNED: Stage[] = [
  'coding',
  'design',
  'docs',
  'validation',
  'review',
  'security',
];

/** Lanes per type, left to right. Security is code-only. */
export function lanesFor(type: CardType): Stage[] {
  switch (type) {
    case 'coding':
      return ['new', 'coding', 'validation', 'review', 'security', 'approval', 'done'];
    case 'design':
      return ['new', 'design', 'validation', 'review', 'approval', 'done'];
    case 'docs':
      return ['new', 'docs', 'validation', 'review', 'approval', 'done'];
  }
}

/** Per-type pipeline checklist stages (v1 design.md §3.3), camelCase keys. */
export function subStateFor(type: CardType): Record<string, SubStateStatus> {
  const stages =
    type === 'coding'
      ? ['retrieveContext', 'implement', 'writeTests', 'runValidation', 'reviewChanges', 'securityReview', 'humanReview']
      : ['draft', 'implement', 'runValidation', 'reviewChanges', 'humanReview'];
  return Object.fromEntries(stages.map((stage) => [stage, 'pending' as const]));
}

/** The lane a card returns to when its work is rejected. */
export function implementLaneFor(type: CardType): Stage {
  switch (type) {
    case 'coding':
      return 'coding';
    case 'design':
      return 'design';
    case 'docs':
      return 'docs';
  }
}

export function isLaneValid(type: CardType, stage: Stage): boolean {
  return lanesFor(type).includes(stage);
}

/** The C# enum member name — v1's rejection messages interpolate these. */
const STAGE_CS_NAMES: Record<Stage, string> = {
  new: 'New',
  coding: 'Coding',
  design: 'Design',
  docs: 'Docs',
  validation: 'Validation',
  review: 'Review',
  security: 'Security',
  approval: 'Approval',
  done: 'Done',
};

export function stageCsName(stage: Stage): string {
  return STAGE_CS_NAMES[stage];
}

export function cardTypeCsName(type: CardType): string {
  return type === 'coding' ? 'Coding' : type === 'design' ? 'Design' : 'Docs';
}
