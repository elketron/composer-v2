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
}

export interface ChatMessage {
  index: number;
  role: string;
  text: string;
  at?: string;
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
