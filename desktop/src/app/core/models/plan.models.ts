import { normalizeMessageRole, toIso } from './coerce';

export type PlanningSessionStatus = 'DRAFTING' | 'DONE';

export const PLANNING_SESSION_STATUSES: readonly PlanningSessionStatus[] = ['DRAFTING', 'DONE'];

export type MessageRole = 'user' | 'agent';

export interface ChatMessageData {
  readonly index: number;
  readonly role: MessageRole | string;
  readonly text: string;
  readonly at?: string | Date;
  readonly activity?: boolean;
  readonly parentIndex?: number;
}

export class ChatMessage {
  readonly index: number;
  readonly role: MessageRole;
  readonly text: string;
  readonly at: string;
  readonly activity: boolean;
  readonly parentIndex: number | null;

  constructor(data: ChatMessageData) {
    this.index = data.index;
    this.role = normalizeMessageRole(data.role);
    this.text = data.text;
    this.at = toIso(data.at);
    this.activity = data.activity === true;
    this.parentIndex = data.parentIndex ?? null;
  }

  get isUser(): boolean {
    return this.role === 'user';
  }

  get isAgent(): boolean {
    return this.role === 'agent';
  }

  with(changes: Partial<ChatMessageData>): ChatMessage {
    return new ChatMessage({
      index: changes.index ?? this.index,
      role: changes.role ?? this.role,
      text: changes.text ?? this.text,
      at: changes.at ?? this.at,
      activity: changes.activity ?? this.activity,
      parentIndex: changes.parentIndex ?? this.parentIndex ?? undefined,
    });
  }
}

export interface PlanningSessionData {
  readonly id: string;
  readonly projectId: string;
  readonly createdAt?: string | Date;
  readonly status?: PlanningSessionStatus | string;
  readonly messages?: readonly (ChatMessage | ChatMessageData)[];
  readonly toolCalls?: readonly (PlanningToolEntry | PlanningToolEntryData)[];
  readonly planDocument?: string;
}

export interface PlanningSessionChanges {
  readonly status?: PlanningSessionStatus;
  readonly messages?: readonly ChatMessage[];
  readonly toolCalls?: readonly PlanningToolEntry[];
  readonly planDocument?: string;
}

export class PlanningSession {
  readonly id: string;
  readonly projectId: string;
  readonly createdAt: string;
  readonly status: PlanningSessionStatus;
  readonly messages: readonly ChatMessage[];
  readonly toolCalls: readonly PlanningToolEntry[];
  readonly planDocument: string;

  constructor(data: PlanningSessionData) {
    this.id = data.id;
    this.projectId = data.projectId;
    this.createdAt = toIso(data.createdAt);
    this.status = normalizePlanningSessionStatus(data.status);
    this.messages = (data.messages ?? []).map((message) =>
      message instanceof ChatMessage ? message : new ChatMessage(message),
    );
    this.toolCalls = (data.toolCalls ?? []).map((entry) => ({
      toolCallId: entry.toolCallId,
      parentIndex: entry.parentIndex ?? null,
      toolName: entry.toolName,
      args: entry.args,
      summary: entry.summary,
      isError: entry.isError,
    }));
    this.planDocument = data.planDocument ?? '';
  }

  get nextMessageIndex(): number {
    return this.messages.reduce((max, message) => Math.max(max, message.index), 0) + 1;
  }

  get transcript(): readonly ChatMessage[] {
    return this.messages;
  }

  get isDone(): boolean {
    return this.status === 'DONE';
  }

  with(changes: PlanningSessionChanges): PlanningSession {
    return new PlanningSession({
      id: this.id,
      projectId: this.projectId,
      createdAt: this.createdAt,
      status: changes.status ?? this.status,
      messages: changes.messages ?? this.messages,
      toolCalls: changes.toolCalls ?? this.toolCalls,
      planDocument: changes.planDocument ?? this.planDocument,
    });
  }

  /**
   * The working box's contents for one turn (the user message it
   * answers): the turn's durable intermediate messages in log order,
   * then its tool calls.
   */
  turnActivityFor(message: ChatMessage): PlanningTurnActivity[] {
    const messages = this.messages
      .filter((entry) => entry.activity && entry.parentIndex === message.index)
      .sort((a, b) => a.index - b.index)
      .map((entry) => ({ kind: 'message' as const, id: `message-${entry.index}`, text: entry.text }));
    const tools = this.toolCalls
      .filter((entry) => entry.parentIndex === message.index)
      .map((tool) => ({ kind: 'tool' as const, id: `tool-${tool.toolCallId}`, tool }));
    return [...messages, ...tools];
  }
}

/** One working-box row: an intermediate message or a tool call. */
export type PlanningTurnActivity =
  | { readonly kind: 'message'; readonly id: string; readonly text: string }
  | { readonly kind: 'tool'; readonly id: string; readonly tool: PlanningToolEntry };

export interface PlanningToolEntryData {
  readonly toolCallId: string;
  readonly parentIndex?: number | null;
  readonly toolName: string;
  readonly args?: unknown;
  readonly summary?: string;
  readonly isError?: boolean;
}

export interface PlanningToolEntry extends Omit<PlanningToolEntryData, 'parentIndex'> {
  readonly parentIndex: number | null;
}

export type PlanEvent =
  | {
      readonly id?: string;
      readonly type: 'PlanningSessionCreated';
      readonly session: PlanningSession | PlanningSessionData;
    }
  | {
      readonly id?: string;
      readonly type: 'UserMessageReceived';
      readonly projectId: string;
      readonly sessionId: string;
      readonly message: ChatMessage | ChatMessageData;
    }
  | {
      readonly id?: string;
      readonly type: 'AgentToolCall';
      readonly projectId: string;
      readonly sessionId: string;
      readonly toolCallId: string;
      readonly parentIndex?: number;
      readonly toolName: string;
      readonly args?: unknown;
    }
  | {
      readonly id?: string;
      readonly type: 'AgentToolResult';
      readonly projectId: string;
      readonly sessionId: string;
      readonly toolCallId: string;
      readonly content: string;
      readonly isError: boolean;
    }
  | {
      readonly id?: string;
      readonly type: 'AgentMessageDelta';
      readonly projectId: string;
      readonly sessionId: string;
      readonly messageIndex: number;
      readonly delta: string;
    }
  | {
      readonly id?: string;
      readonly type: 'AgentMessageComplete';
      readonly projectId: string;
      readonly sessionId: string;
      readonly message: ChatMessage | ChatMessageData;
    }
  | {
      readonly id?: string;
      readonly type: 'PlanDocumentUpdated';
      readonly projectId: string;
      readonly sessionId: string;
      readonly document: string;
    }
  | {
      readonly id?: string;
      readonly type: 'PlanningSessionCompleted';
      readonly projectId: string;
      readonly sessionId: string;
    }
  | {
      readonly id?: string;
      readonly type: 'CardsCommitted';
      readonly projectId: string;
      // The wire mapping coerced these already (plan.service's
      // planEventFromWire runs cardFromWire) — committed cards, not raw.
      readonly cards: import('./board.models').Card[];
    };

export type PlanCommand =
  | {
      readonly type: 'RequestPlanningSessionCreate';
      readonly projectId: string;
    }
  | {
      readonly type: 'RequestUserMessage';
      readonly projectId: string;
      readonly sessionId: string;
      readonly text: string;
    };

export function normalizePlanningSessionStatus(
  status: PlanningSessionStatus | string | undefined,
): PlanningSessionStatus {
  const normalized = status?.toUpperCase();
  return normalized === 'DONE' ? 'DONE' : 'DRAFTING';
}

// ---- Plan document representation ----

/** One ticket block embedded in the planner's markdown plan document. */
export interface PlanTicket {
  readonly title: string;
  readonly cardType: 'coding' | 'design' | 'docs';
  readonly blockedBy: readonly string[];
  readonly description: string;
}

/** A slice of the plan document: prose, or an embedded ticket block. */
export type PlanSegment =
  | { readonly kind: 'prose'; readonly markdown: string }
  | { readonly kind: 'ticket'; readonly ticket: PlanTicket };

/**
 * Splits the planner's markdown plan into prose and ticket segments. A
 * ticket is a bracketed heading (`#[Title]` — the brackets mark it as a
 * ticket, unlike a normal markdown title) immediately followed by a `---`
 * YAML frontmatter fence (`cardType`, `key`, `blockedBy`) and its markdown
 * description.
 */
export function parsePlanDocument(document: string): PlanSegment[] {
  const lines = document.split(/\r?\n/);
  const segments: PlanSegment[] = [];
  let prose: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const title = headingTitle(lines[i]);
    if (title === null) {
      prose.push(lines[i] ?? '');
      i++;
      continue;
    }
    let j = i + 1;
    while (j < lines.length && lines[j]?.trim() === '') j++;
    if (lines[j]?.trim() !== '---') {
      prose.push(lines[i] ?? '');
      i++;
      continue;
    }
    const fields: string[] = [];
    j++;
    while (
      j < lines.length &&
      lines[j]?.trim() !== '---' &&
      headingTitle(lines[j]) === null &&
      !isMarkdownHeading(lines[j])
    ) {
      fields.push(lines[j] ?? '');
      j++;
    }
    if (lines[j]?.trim() !== '---') {
      prose.push(lines[i] ?? '');
      i++;
      continue;
    }
    if (prose.length > 0) {
      const markdown = prose.join('\n').trim();
      if (markdown !== '') segments.push({ kind: 'prose', markdown });
      prose = [];
    }
    j++;
    const body: string[] = [];
    while (j < lines.length && headingTitle(lines[j]) === null && !isMarkdownHeading(lines[j])) {
      body.push(lines[j] ?? '');
      j++;
    }
    const ticket = parseTicket(title, fields, body.join('\n').trim());
    if (ticket === null) {
      prose.push(...lines.slice(i, j));
    } else {
      segments.push({ kind: 'ticket', ticket });
    }
    i = j;
  }
  if (prose.length > 0) {
    const markdown = prose.join('\n').trim();
    if (markdown !== '') segments.push({ kind: 'prose', markdown });
  }
  return segments;
}

function headingTitle(line: string | undefined): string | null {
  if (line === undefined) return null;
  const trimmed = line.trim();
  const bracketed = /^#\[(.+)\]$/.exec(trimmed);
  if (bracketed !== null) return bracketed[1]!.trim();
  return null;
}

/** An ordinary ATX heading starts a new plan-level prose section. */
function isMarkdownHeading(line: string | undefined): boolean {
  return line !== undefined && /^ {0,3}#{1,6}(?:\s+|$)/.test(line);
}

function parseTicket(title: string, fields: readonly string[], body: string): PlanTicket | null {
  let cardType: PlanTicket['cardType'] = 'coding';
  const blockedBy: string[] = [];
  let i = 0;
  while (i < fields.length) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(fields[i] ?? '');
    if (match === null) {
      i++;
      continue;
    }
    const field = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (field === 'cardtype') {
      if (value !== 'design' && value !== 'docs' && value !== 'coding') return null;
      cardType = value;
      i++;
    } else if (field === 'blockedby') {
      if (value !== '') {
        for (const dep of inlineList(value)) blockedBy.push(dep);
        i++;
      } else {
        i++;
        while (i < fields.length && /^\s*-\s+/.test(fields[i] ?? '')) {
          blockedBy.push((fields[i] ?? '').replace(/^\s*-\s+/, '').trim());
          i++;
        }
      }
    } else {
      i++;
    }
  }
  return { title, cardType, blockedBy, description: body };
}

function inlineList(value: string): string[] {
  const inner = value.replace(/^\[/, '').replace(/\]$/, '');
  if (inner.trim() === '') return [];
  return inner
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter((item) => item !== '');
}
