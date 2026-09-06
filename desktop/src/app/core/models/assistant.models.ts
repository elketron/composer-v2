export type AssistantThreadStatus = 'IDLE' | 'RUNNING' | 'FAILED' | 'STOPPED';

export type MessageRole = 'user' | 'agent';

export interface AssistantMessageData {
  readonly index: number;
  readonly role: MessageRole | string;
  readonly text: string;
  readonly at?: string | Date;
  readonly id?: string;
  readonly parentId?: string;
}

export class AssistantMessage {
  readonly index: number;
  readonly role: MessageRole;
  readonly text: string;
  readonly at: string;
  /** Stable message id (branch lineage); '' for pre-S21 transcripts. */
  readonly id: string;
  /** The message this one follows; null = thread root. */
  readonly parentId: string | null;

  constructor(data: AssistantMessageData) {
    this.index = data.index;
    this.role = normalizeMessageRole(data.role);
    this.text = data.text;
    this.at = toIso(data.at);
    this.id = data.id ?? '';
    this.parentId = data.parentId ?? null;
  }

  get isUser(): boolean {
    return this.role === 'user';
  }

  get isAgent(): boolean {
    return this.role === 'agent';
  }
}

export interface AssistantThreadData {
  readonly id: string;
  readonly name?: string;
  readonly createdAt?: string | Date;
  readonly status?: AssistantThreadStatus | string;
  readonly projectIds?: readonly string[];
  readonly archivedAt?: string | null;
  readonly messages?: readonly (AssistantMessage | AssistantMessageData)[];
  readonly toolCalls?: readonly (AssistantToolEntry | AssistantToolEntryData)[];
}

export class AssistantThread {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly status: AssistantThreadStatus;
  readonly projectIds: readonly string[];
  readonly archivedAt: string | null;
  readonly messages: readonly AssistantMessage[];
  readonly toolCalls: readonly AssistantToolEntry[];

  constructor(data: AssistantThreadData) {
    this.id = data.id;
    this.name = data.name ?? '';
    this.createdAt = toIso(data.createdAt);
    this.status = normalizeThreadStatus(data.status);
    this.projectIds = [...(data.projectIds ?? [])];
    this.archivedAt = data.archivedAt ?? null;
    this.messages = (data.messages ?? []).map((message) =>
      message instanceof AssistantMessage ? message : new AssistantMessage(message),
    );
    this.toolCalls = (data.toolCalls ?? [])
      .map((entry) => toolEntryFromWire(entry))
      .filter((entry): entry is AssistantToolEntry => entry !== null);
  }

  get isActive(): boolean {
    return this.archivedAt === null;
  }

  get isRunning(): boolean {
    return this.status === 'RUNNING';
  }

  get lastMessage(): AssistantMessage | undefined {
    return this.messages.at(-1);
  }

  /** Rebuilds the thread with changes (message folds replace by index). */
  withMessages(messages: readonly AssistantMessage[]): AssistantThread {
    return new AssistantThread({
      id: this.id,
      name: this.name,
      createdAt: this.createdAt,
      status: this.status,
      projectIds: this.projectIds,
      archivedAt: this.archivedAt,
      messages,
      toolCalls: this.toolCalls,
    });
  }

  /** Rebuilds the thread with replaced tool activity (the working box). */
  withToolCalls(toolCalls: readonly AssistantToolEntry[]): AssistantThread {
    return new AssistantThread({
      id: this.id,
      name: this.name,
      createdAt: this.createdAt,
      status: this.status,
      projectIds: this.projectIds,
      archivedAt: this.archivedAt,
      messages: this.messages,
      toolCalls,
    });
  }

  /** The tool activity of one turn (the user message it answers). */
  toolCallsFor(parentId: string | null): AssistantToolEntry[] {
    return this.toolCalls.filter((entry) => entry.parentId === parentId);
  }
}

export function normalizeThreadStatus(
  status: AssistantThreadStatus | string | undefined,
): AssistantThreadStatus {
  const normalized = status?.toUpperCase();
  if (normalized === 'RUNNING') return 'RUNNING';
  if (normalized === 'FAILED') return 'FAILED';
  if (normalized === 'STOPPED') return 'STOPPED';
  return 'IDLE';
}

function normalizeMessageRole(role: MessageRole | string): MessageRole {
  return role.toLowerCase() === 'agent' ? 'agent' : 'user';
}

/**
 * One tool call an assistant turn made (S25: the working box). The call
 * creates the entry; the result patches its summary in place. `parentId`
 * groups entries under the user message the turn answers.
 */
export interface AssistantToolEntry {
  readonly toolCallId: string;
  readonly parentId: string | null;
  readonly toolName: string;
  readonly args?: unknown;
  readonly summary?: string;
  readonly isError?: boolean;
}

export interface AssistantToolEntryData {
  readonly toolCallId: string;
  readonly parentId?: string | null;
  readonly toolName: string;
  readonly args?: unknown;
  readonly summary?: string;
  readonly isError?: boolean;
}

export function toolEntryFromWire(value: unknown): AssistantToolEntry | null {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  if (record === null || typeof record['toolCallId'] !== 'string') return null;
  return {
    toolCallId: record['toolCallId'],
    parentId: typeof record['parentId'] === 'string' ? record['parentId'] : null,
    toolName: typeof record['toolName'] === 'string' ? record['toolName'] : '',
    args: record['args'],
    summary: typeof record['summary'] === 'string' ? record['summary'] : undefined,
    isError: record['isError'] === true ? true : undefined,
  };
}

function toIso(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString();
  return value ?? new Date().toISOString();
}

// ---- Work proposals (Phase 8) ----

export type ProposalCardType = 'coding' | 'design' | 'docs';
export type ProposalStatus = 'DRAFTED' | 'CONFIRMED' | 'DISCARDED';

export interface ProposalItem {
  id: string;
  projectId: string;
  title: string;
  description: string;
  cardType: ProposalCardType;
  key?: string;
  blockedBy: string[];
  included: boolean;
}

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
  outcomes?: ProposalOutcome[];
  confirmedAt?: string;
}

export function normalizeProposalStatus(status: string | undefined): ProposalStatus {
  const normalized = status?.toUpperCase();
  if (normalized === 'CONFIRMED') return 'CONFIRMED';
  if (normalized === 'DISCARDED') return 'DISCARDED';
  return 'DRAFTED';
}

export function normalizeProposalCardType(value: unknown): ProposalCardType {
  return value === 'design' || value === 'docs' ? value : 'coding';
}

export function proposalItemFromWire(value: unknown): ProposalItem {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  return {
    id: typeof record['id'] === 'string' ? record['id'] : '',
    projectId: typeof record['projectId'] === 'string' ? record['projectId'] : '',
    title: typeof record['title'] === 'string' ? record['title'] : '',
    description: typeof record['description'] === 'string' ? record['description'] : '',
    cardType: normalizeProposalCardType(record['cardType']),
    key: typeof record['key'] === 'string' ? record['key'] : undefined,
    blockedBy: Array.isArray(record['blockedBy'])
      ? record['blockedBy'].filter((entry): entry is string => typeof entry === 'string')
      : [],
    included: record['included'] !== false,
  };
}
