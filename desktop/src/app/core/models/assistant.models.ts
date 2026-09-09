import { renderMarkdown } from '../markdown';

export type AssistantThreadStatus = 'IDLE' | 'RUNNING' | 'FAILED' | 'STOPPED';

export type MessageRole = 'user' | 'agent';

export interface AssistantMessageData {
  readonly index: number;
  readonly role: MessageRole | string;
  readonly text: string;
  readonly at?: string | Date;
  readonly id?: string;
  readonly parentId?: string;
  readonly activity?: boolean;
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
  /** Intermediate output rendered inside the parent turn's activity pane. */
  readonly activity: boolean;

  constructor(data: AssistantMessageData) {
    this.index = data.index;
    this.role = normalizeMessageRole(data.role);
    this.text = data.text;
    this.at = toIso(data.at);
    this.id = data.id ?? '';
    this.parentId = data.parentId ?? null;
    this.activity = data.activity === true;
  }

  get isUser(): boolean {
    return this.role === 'user';
  }

  get isAgent(): boolean {
    return this.role === 'agent';
  }

  /** The note title a "remember" derives: the reply's first markdown line. */
  get title(): string {
    const line = this.text
      .split('\n')
      .map((candidate) => candidate.replace(/^#+\s*/, '').replace(/[*_`>]/g, '').trim())
      .find((candidate) => candidate !== '');
    return truncate(line ?? 'saved reply', 60);
  }

  /** Agent replies render as safe markdown; user messages stay plain text. */
  markup(): string {
    return renderMarkdown(this.text);
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

// ---- Proposal editing + tool-strip repr ----

/**
 * The proposal panel's working copy (F3): the editable copies of a drafted
 * proposal's items that confirmation sends back. Immutable — the component
 * swaps instances on edit.
 */
export class ProposalDraft {
  private constructor(
    readonly id: string,
    readonly items: readonly ProposalItem[],
  ) {}

  static fromProposal(proposal: CardProposal): ProposalDraft {
    return new ProposalDraft(
      proposal.id,
      proposal.items.map((item) => ({ ...item })),
    );
  }

  includedCount(): number {
    return this.items.filter((item) => item.included).length;
  }

  toggleInclude(index: number, included: boolean): ProposalDraft {
    return this.mapItem(index, { included });
  }

  setTitle(index: number, title: string): ProposalDraft {
    return this.mapItem(index, { title });
  }

  setDescription(index: number, description: string): ProposalDraft {
    return this.mapItem(index, { description });
  }

  setType(index: number, cardType: ProposalCardType): ProposalDraft {
    return this.mapItem(index, { cardType });
  }

  /** The items a confirm publishes (copies, so the live edit stays intact). */
  toItems(): ProposalItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  private mapItem(index: number, patch: Partial<ProposalItem>): ProposalDraft {
    return new ProposalDraft(
      this.id,
      this.items.map((item, at) => (at === index ? { ...item, ...patch } : item)),
    );
  }
}

/** A tool row's label: the unprefixed name + its first string argument. */
export function assistantToolLabel(entry: AssistantToolEntry): string {
  const name = entry.toolName.replace(/^composer_/, '');
  const digest = argDigest(entry.args);
  return digest !== '' ? `${name} · ${digest}` : name;
}

/** The first string arg (path, url, query) as the row's digest. */
function argDigest(args: unknown): string {
  if (typeof args !== 'object' || args === null) return '';
  const values = Object.values(args as Record<string, unknown>);
  const first = values.find((value) => typeof value === 'string' && value !== '');
  if (typeof first === 'string') return truncate(first, 48);
  if (values.length > 0) return truncate(JSON.stringify(args), 48);
  return '';
}

function truncate(value: string, cap: number): string {
  return value.length <= cap ? value : `${value.slice(0, cap)}…`;
}
