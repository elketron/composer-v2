export type PlanningSessionStatus = 'DRAFTING' | 'DONE';

export const PLANNING_SESSION_STATUSES: readonly PlanningSessionStatus[] = ['DRAFTING', 'DONE'];

export type MessageRole = 'user' | 'agent';

export interface ChatMessageData {
  readonly index: number;
  readonly role: MessageRole | string;
  readonly text: string;
  readonly at?: string | Date;
}

export class ChatMessage {
  readonly index: number;
  readonly role: MessageRole;
  readonly text: string;
  readonly at: string;

  constructor(data: ChatMessageData) {
    this.index = data.index;
    this.role = normalizeMessageRole(data.role);
    this.text = data.text;
    this.at = toIso(data.at);
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
    });
  }
}

export interface PlanningSessionData {
  readonly id: string;
  readonly projectId: string;
  readonly createdAt?: string | Date;
  readonly status?: PlanningSessionStatus | string;
  readonly messages?: readonly (ChatMessage | ChatMessageData)[];
  readonly planDocument?: string;
}

export interface PlanningSessionChanges {
  readonly status?: PlanningSessionStatus;
  readonly messages?: readonly ChatMessage[];
  readonly planDocument?: string;
}

export class PlanningSession {
  readonly id: string;
  readonly projectId: string;
  readonly createdAt: string;
  readonly status: PlanningSessionStatus;
  readonly messages: readonly ChatMessage[];
  readonly planDocument: string;

  constructor(data: PlanningSessionData) {
    this.id = data.id;
    this.projectId = data.projectId;
    this.createdAt = toIso(data.createdAt);
    this.status = normalizePlanningSessionStatus(data.status);
    this.messages = (data.messages ?? []).map((message) =>
      message instanceof ChatMessage ? message : new ChatMessage(message),
    );
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
      planDocument: changes.planDocument ?? this.planDocument,
    });
  }
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
      readonly sessionId: string;
      readonly message: ChatMessage | ChatMessageData;
    }
  | {
      readonly id?: string;
      readonly type: 'AgentMessageDelta';
      readonly sessionId: string;
      readonly messageIndex: number;
      readonly delta: string;
    }
  | {
      readonly id?: string;
      readonly type: 'AgentMessageComplete';
      readonly sessionId: string;
      readonly message: ChatMessage | ChatMessageData;
    }
  | {
      readonly id?: string;
      readonly type: 'PlanDocumentUpdated';
      readonly sessionId: string;
      readonly document: string;
    }
  | {
      readonly id?: string;
      readonly type: 'PlanningSessionCompleted';
      readonly sessionId: string;
    }
  | {
      readonly id?: string;
      readonly type: 'CardsCommitted';
      readonly cards: readonly unknown[];
    };

export type PlanCommand =
  | {
      readonly type: 'RequestPlanningSessionCreate';
      readonly projectId: string;
    }
  | {
      readonly type: 'RequestUserMessage';
      readonly sessionId: string;
      readonly text: string;
    };

export function normalizePlanningSessionStatus(
  status: PlanningSessionStatus | string | undefined,
): PlanningSessionStatus {
  const normalized = status?.toUpperCase();
  return normalized === 'DONE' ? 'DONE' : 'DRAFTING';
}

function normalizeMessageRole(role: MessageRole | string): MessageRole {
  return role.toLowerCase() === 'agent' ? 'agent' : 'user';
}

function toIso(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString();
  return value ?? new Date().toISOString();
}
