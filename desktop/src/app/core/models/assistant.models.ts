export type AssistantThreadStatus = 'IDLE' | 'RUNNING' | 'FAILED' | 'STOPPED';

export type MessageRole = 'user' | 'agent';

export interface AssistantMessageData {
  readonly index: number;
  readonly role: MessageRole | string;
  readonly text: string;
  readonly at?: string | Date;
}

export class AssistantMessage {
  readonly index: number;
  readonly role: MessageRole;
  readonly text: string;
  readonly at: string;

  constructor(data: AssistantMessageData) {
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
}

export interface AssistantThreadData {
  readonly id: string;
  readonly name?: string;
  readonly createdAt?: string | Date;
  readonly status?: AssistantThreadStatus | string;
  readonly projectIds?: readonly string[];
  readonly archivedAt?: string | null;
  readonly messages?: readonly (AssistantMessage | AssistantMessageData)[];
}

export class AssistantThread {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly status: AssistantThreadStatus;
  readonly projectIds: readonly string[];
  readonly archivedAt: string | null;
  readonly messages: readonly AssistantMessage[];

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
    });
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

function toIso(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString();
  return value ?? new Date().toISOString();
}
