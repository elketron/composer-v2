import { Injectable, computed, inject, signal } from '@angular/core';

import { EventsClient } from '../core/events/events-client';
import {
  DomainEventJson,
  PublishRequestJson,
  PublishResponseJson,
  cardFromWire,
  domainEventKind,
  planningSessionStatusFromWire,
} from '../core/events/wire';
import {
  ChatMessage,
  ChatMessageData,
  PlanCommand,
  PlanEvent,
  PlanningSession,
  PlanningSessionData,
} from '../core/models/plan.models';
import { Assignee, Card, CardType, Stage } from '../core/models/board.models';

/**
 * Planning sessions: a fold of the event stream (PlanningSessionCreated,
 * UserMessageReceived, AgentMessageDelta/Complete, PlanDocumentUpdated,
 * PlanningSessionCompleted, CardsCommitted) with commands over publish
 * (RequestPlanningSessionCreate, RequestUserMessage). The planner runs
 * server-side (a pi agent in the agent host): it edits the plan document
 * and emits tickets; this service only folds its events.
 *
 * Session creation is lazy and awaited on the first send: an eager create at
 * startup would race the snapshot that re-delivers the persisted session and
 * duplicate it. For the same reason the PlanningSessionCreated fold never
 * lets a different, empty session clobber a populated one.
 */
@Injectable({ providedIn: 'root' })
export class PlanService {
  private static readonly SEEN_IDS_CAP = 4096;

  private readonly events = inject(EventsClient);

  private readonly sessionsSignal = signal<ReadonlyMap<string, PlanningSession>>(new Map());
  private readonly activeProjectSignal = signal<string | null>(null);
  private readonly pendingSessions = new Map<string, Promise<PlanningSession | null>>();
  private readonly seenEventIds = new Map<string, true>();

  readonly sessions = this.sessionsSignal.asReadonly();
  readonly projectId = this.activeProjectSignal.asReadonly();
  readonly session = computed(() => {
    const projectId = this.activeProjectSignal();
    return projectId ? (this.sessionsSignal().get(projectId) ?? null) : null;
  });
  readonly messages = computed(() => {
    const messages = this.session()?.messages ?? [];
    // Re-delivered events can land the same slot twice under different
    // indices; the transcript must render each (role, index) once — the
    // latest write wins.
    const seen = new Map<string, ChatMessage>();
    for (const message of messages) {
      seen.set(`${message.role}-${message.index}`, message);
    }
    return [...seen.values()];
  });
  readonly transcript = this.messages;
  readonly planDocument = computed(() => this.session()?.planDocument ?? '');
  readonly status = computed(() => this.session()?.status ?? 'DRAFTING');
  readonly isDone = computed(() => this.session()?.isDone ?? false);
  readonly streamingMessage = signal<ChatMessage | null>(null);
  readonly isSending = signal(false);
  readonly loading = this.isSending;
  readonly error = signal<string | null>(null);
  readonly committedCards = signal<readonly Card[]>([]);
  readonly commands = signal<readonly PlanCommand[]>([]);
  readonly lastCommand = computed(() => this.commands().at(-1) ?? null);

  constructor() {
    this.events.events$.subscribe((event) => {
      const planEvent = planEventFromWire(event);
      if (planEvent) this.applyEvent(planEvent);
    });
  }

  setProject(projectId: string | null): void {
    const normalized = projectId?.trim() || null;
    if (normalized === this.activeProjectSignal()) return;
    this.activeProjectSignal.set(normalized);
    this.streamingMessage.set(null);
    this.error.set(null);
  }

  /** RequestUserMessage; the planner's answer arrives on the stream. */
  async sendMessage(text: string): Promise<boolean> {
    const value = text.trim();
    const projectId = this.activeProjectSignal();
    if (!value || !projectId || this.isSending()) return false;

    this.error.set(null);
    this.isSending.set(true);
    const session = this.session() ?? (await this.createSession(projectId));
    if (!session) {
      this.isSending.set(false);
      this.error.set('could not start a planning session');
      return false;
    }
    const response = await this.publishCommand({
      type: 'RequestUserMessage',
      sessionId: session.id,
      text: value,
    });
    if (!response.ok) {
      this.isSending.set(false);
      this.error.set(response.rejectionMessage ?? 'message rejected');
      return false;
    }
    return true;
  }

  requestUserMessage(text: string): Promise<boolean> {
    return this.sendMessage(text);
  }

  requestPlanningSessionCreate(projectId: string): void {
    void this.publishCommand({ type: 'RequestPlanningSessionCreate', projectId });
  }

  applyServerEvent(event: PlanEvent): void {
    this.applyEvent(event);
  }

  applyEvent(event: PlanEvent): void {
    if (event.id) {
      if (this.seenEventIds.has(event.id)) return;
      this.seenEventIds.set(event.id, true);
      if (this.seenEventIds.size > PlanService.SEEN_IDS_CAP) {
        const oldest = this.seenEventIds.keys().next().value;
        if (oldest !== undefined) this.seenEventIds.delete(oldest);
      }
    }

    switch (event.type) {
      case 'PlanningSessionCreated': {
        const incoming = asSession(event.session);
        const existing = this.sessionsSignal().get(incoming.projectId);
        // A duplicate (or stale snapshot) session must not clobber a
        // populated one; same-id replaces are snapshot replays and safe —
        // the transcript events re-fold right after.
        if (
          existing &&
          existing.id !== incoming.id &&
          (existing.messages.length > 0 || existing.planDocument.trim() !== '')
        )
          break;
        this.setProjectSession(incoming.projectId, incoming);
        break;
      }
      case 'UserMessageReceived': {
        if (!this.isPlanningSession(event.sessionId)) break;
        const message = asMessage(event.message);
        this.updateSessionById(event.sessionId, (session) =>
          session.with({ messages: upsertMessage(session.messages, message) }),
        );
        if (event.sessionId === this.session()?.id) {
          this.streamingMessage.set(
            new ChatMessage({ index: message.index + 1, role: 'agent', text: '' }),
          );
        }
        break;
      }
      case 'AgentMessageDelta': {
        // Agent-step messages (card sessions, A-*) are the pipeline run
        // view's; only known planning sessions fold here — a coder's
        // stream must never replace the plan session.
        if (!this.isPlanningSession(event.sessionId)) break;
        const current = this.streamingMessage();
        const message =
          current?.index === event.messageIndex
            ? current.with({ text: current.text + event.delta })
            : new ChatMessage({ index: event.messageIndex, role: 'agent', text: event.delta });
        this.streamingMessage.set(message);
        break;
      }
      case 'AgentMessageComplete': {
        if (!this.isPlanningSession(event.sessionId)) break;
        const message = asMessage(event.message);
        this.updateSessionById(event.sessionId, (session) =>
          session.with({ messages: upsertMessage(session.messages, message) }),
        );
        // The completion's index can disagree with the deltas' numbering
        // (observed off-by-one), so key the match on "a live stream for the
        // active session ended" — the planner is single-writer per session.
        if (event.sessionId === this.session()?.id) {
          this.streamingMessage.set(null);
          this.isSending.set(false);
        }
        break;
      }
      case 'PlanDocumentUpdated': {
        this.updateSessionById(event.sessionId, (session) =>
          session.with({ planDocument: event.document }),
        );
        break;
      }
      case 'PlanningSessionCompleted': {
        this.updateSessionById(event.sessionId, (session) =>
          session.with({ status: 'DONE' }),
        );
        break;
      }
      case 'CardsCommitted': {
        const cards = event.cards
          .map(asCommittedCard)
          .filter((card): card is Card => card !== null);
        this.committedCards.set(cards);
        break;
      }
    }
  }

  // ---- Internals ----

  /** The planning session for the project, creating it on demand (awaited). */
  private createSession(projectId: string): Promise<PlanningSession | null> {
    const pending = this.pendingSessions.get(projectId);
    if (pending) return pending;

    const promise = new Promise<PlanningSession | null>((resolve) => {
      const timer = setTimeout(() => finish(null), 10_000);
      const subscription = this.events.events$.subscribe((event) => {
        if (
          domainEventKind(event) === 'planningSessionCreated' &&
          event.planningSessionCreated?.session?.projectId === projectId
        ) {
          finish(this.sessionsSignal().get(projectId) ?? null);
        }
      });
      const finish = (session: PlanningSession | null) => {
        clearTimeout(timer);
        subscription.unsubscribe();
        resolve(session);
      };
      void this.publishCommand({ type: 'RequestPlanningSessionCreate', projectId }).then(
        (response) => {
          if (!response.ok) finish(null);
        },
      );
    }).finally(() => this.pendingSessions.delete(projectId));

    this.pendingSessions.set(projectId, promise);
    return promise;
  }

  private publishCommand(command: PlanCommand): Promise<PublishResponseJson> {
    this.commands.update((commands) => [...commands.slice(-99), command]);
    const projectId =
      command.type === 'RequestPlanningSessionCreate'
        ? command.projectId
        : (this.activeProjectSignal() ?? '');
    const request = {
      projectId,
      [lcfirst(command.type)]: commandPayload(command),
    } as unknown as PublishRequestJson;
    return this.events.publish(request);
  }

  /**
   * True when the id belongs to a planning session this service already
   * folds. Card-bound agent sessions (the runner's A-*) publish the same
   * message event names — they are the pipeline run view's, not the plan's.
   */
  private isPlanningSession(sessionId: string | undefined): boolean {
    if (sessionId === undefined) return false;
    for (const session of this.sessionsSignal().values()) {
      if (session.id === sessionId) return true;
    }
    // The active project's pending create (the id arrives on the echo).
    return false;
  }

  private updateSessionById(
    sessionId: string,
    updater: (session: PlanningSession) => PlanningSession,
    fallbackProjectId = this.activeProjectSignal() ?? '',
  ): void {
    const projectId = this.projectForSession(sessionId) ?? fallbackProjectId;
    const existing = this.sessionsSignal().get(projectId);
    if (!existing) {
      this.setProjectSession(
        projectId,
        new PlanningSession({ id: sessionId, projectId, createdAt: new Date() }),
      );
    } else if (existing.id !== sessionId) {
      this.setProjectSession(
        projectId,
        new PlanningSession({
          id: sessionId,
          projectId,
          createdAt: existing.createdAt,
        }),
      );
    }
    this.updateProjectSession(projectId, (session) => updater(session));
  }

  private updateProjectSession(
    projectId: string,
    updater: (session: PlanningSession) => PlanningSession,
  ): void {
    this.sessionsSignal.update((sessions) => {
      const current = sessions.get(projectId);
      if (!current) return sessions;
      const next = new Map(sessions);
      next.set(projectId, updater(current));
      return next;
    });
  }

  private setProjectSession(projectId: string, session: PlanningSession): void {
    this.sessionsSignal.update((sessions) => {
      const next = new Map(sessions);
      next.set(projectId, session);
      return next;
    });
  }

  private projectForSession(sessionId: string): string | null {
    for (const [projectId, session] of this.sessionsSignal()) {
      if (session.id === sessionId) return projectId;
    }
    return null;
  }
}

// ---- Wire mapping ----

/** Map a wire event to a PlanEvent; null for events the plan view ignores. */
function planEventFromWire(event: DomainEventJson): PlanEvent | null {
  const id = event.id;
  switch (domainEventKind(event)) {
    case 'planningSessionCreated': {
      const session = event.planningSessionCreated?.session;
      if (!session) return null;
      return {
        id,
        type: 'PlanningSessionCreated',
        session: {
          id: session.id ?? '',
          projectId: session.projectId ?? '',
          createdAt: session.createdAt,
          status: planningSessionStatusFromWire(session.status),
          messages: (session.messages ?? []).map((message) => ({
            index: message.index ?? 0,
            role: message.role ?? 'user',
            text: message.text ?? '',
            at: message.at,
          })),
          planDocument: session.planDocument ?? '',
        },
      };
    }
    case 'userMessageReceived': {
      const payload = event.userMessageReceived;
      if (!payload?.message) return null;
      return {
        id,
        type: 'UserMessageReceived',
        sessionId: payload.sessionId ?? '',
        message: {
          index: payload.message.index ?? 0,
          role: payload.message.role ?? 'user',
          text: payload.message.text ?? '',
          at: payload.message.at,
        },
      };
    }
    case 'agentMessageDelta': {
      const payload = event.agentMessageDelta;
      if (!payload) return null;
      return {
        id,
        type: 'AgentMessageDelta',
        sessionId: payload.sessionId ?? '',
        messageIndex: payload.messageIndex ?? 0,
        delta: payload.delta ?? '',
      };
    }
    case 'agentMessageComplete': {
      const payload = event.agentMessageComplete;
      if (!payload?.message) return null;
      return {
        id,
        type: 'AgentMessageComplete',
        sessionId: payload.sessionId ?? '',
        message: {
          index: payload.message.index ?? 0,
          role: payload.message.role ?? 'agent',
          text: payload.message.text ?? '',
          at: payload.message.at,
        },
      };
    }
    case 'planDocumentUpdated': {
      const payload = event.planDocumentUpdated;
      if (!payload) return null;
      return {
        id,
        type: 'PlanDocumentUpdated',
        sessionId: payload.sessionId ?? '',
        document: payload.document ?? '',
      };
    }
    case 'planningSessionCompleted': {
      const payload = event.planningSessionCompleted;
      if (!payload) return null;
      return {
        id,
        type: 'PlanningSessionCompleted',
        sessionId: payload.sessionId ?? '',
      };
    }
    case 'cardsCommitted':
      return {
        id,
        type: 'CardsCommitted',
        cards: (event.cardsCommitted?.cards ?? []).map(cardFromWire),
      };
    default:
      return null;
  }
}

/** Map a PlanCommand onto its PublishRequest payload (proto field names). */
function commandPayload(command: PlanCommand): Record<string, unknown> {
  switch (command.type) {
    case 'RequestPlanningSessionCreate':
      return { projectId: command.projectId };
    case 'RequestUserMessage':
      return { sessionId: command.sessionId, text: command.text };
  }
}

function lcfirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

// ---- Event payload coercion (server events fed as plain data) ----

function asMessage(value: ChatMessage | ChatMessageData): ChatMessage {
  return value instanceof ChatMessage ? value : new ChatMessage(value);
}

function asSession(value: PlanningSession | PlanningSessionData): PlanningSession {
  return value instanceof PlanningSession ? value : new PlanningSession(value);
}

function upsertMessage(
  messages: readonly ChatMessage[],
  incoming: ChatMessage,
): readonly ChatMessage[] {
  const existing = messages.findIndex(
    (message) => message.index === incoming.index && message.role === incoming.role,
  );
  const next = [...messages];
  if (existing >= 0) next[existing] = incoming;
  else next.push(incoming);
  return next.sort(
    (a, b) => a.index - b.index || (a.role === b.role ? 0 : a.role === 'user' ? -1 : 1),
  );
}

interface CardDto {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly stage?: unknown;
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
  readonly tags?: unknown;
  readonly blockedBy?: unknown;
  readonly subState?: unknown;
  readonly retries?: unknown;
  readonly title?: unknown;
  readonly description?: unknown;
  readonly assignee?: unknown;
  readonly sessionId?: unknown;
  readonly branch?: unknown;
  readonly fileStats?: unknown;
}

interface AssigneeDto {
  readonly role?: unknown;
  readonly model?: unknown;
  readonly effort?: unknown;
}

interface FileStatsDto {
  readonly added?: unknown;
  readonly removed?: unknown;
  readonly files?: unknown;
}

function asCommittedCard(value: unknown): Card | null {
  if (value instanceof Card) return value;
  if (!isRecord(value)) return null;
  const dto = value as CardDto;
  if (typeof dto.id !== 'string') return null;
  const type = cardType(dto.type);
  const stage = cardStage(dto.stage, type);
  const timestamp = typeof dto.createdAt === 'string' ? dto.createdAt : new Date().toISOString();
  const updatedAt = typeof dto.updatedAt === 'string' ? dto.updatedAt : timestamp;
  const tags = arrayOfStrings(dto.tags);
  const blockedBy = arrayOfStrings(dto.blockedBy);
  const subState = isRecord(dto.subState) ? dto.subState : {};
  const retries = isRecord(dto.retries) ? dto.retries : {};

  return new Card({
    id: dto.id,
    type,
    title: typeof dto.title === 'string' ? dto.title : 'Untitled card',
    description: typeof dto.description === 'string' ? dto.description : '',
    tags,
    stage,
    blockedBy,
    assignee: asAssignee(dto.assignee),
    sessionId: typeof dto.sessionId === 'string' ? dto.sessionId : undefined,
    branch: typeof dto.branch === 'string' ? dto.branch : undefined,
    fileStats: asFileStats(dto.fileStats),
    subState: subState as Card['subState'],
    retries: retries as Readonly<Record<string, number>>,
    createdAt: timestamp,
    updatedAt,
  });
}

function asAssignee(value: unknown): Assignee | undefined {
  if (!isRecord(value)) return undefined;
  const dto = value as AssigneeDto;
  if (typeof dto.role !== 'string') return undefined;
  if (dto.role === 'human') return Assignee.human();
  return Assignee.for(
    dto.role as Parameters<typeof Assignee.for>[0],
    typeof dto.model === 'string' ? dto.model : '',
    typeof dto.effort === 'string' ? dto.effort : '',
  );
}

function asFileStats(
  value: unknown,
): { added: number; removed: number; files: number } | undefined {
  if (!isRecord(value)) return undefined;
  const dto = value as FileStatsDto;
  return {
    added: typeof dto.added === 'number' ? dto.added : 0,
    removed: typeof dto.removed === 'number' ? dto.removed : 0,
    files: typeof dto.files === 'number' ? dto.files : 0,
  };
}

function cardType(value: unknown): CardType {
  return value === 'design' || value === 'docs' || value === 'coding' ? value : 'coding';
}

function cardStage(value: unknown, type: CardType): Stage {
  const stage = typeof value === 'string' ? value : 'new';
  const valid: readonly Stage[] = [
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
  return valid.includes(stage as Stage) && (type === 'coding' || stage !== 'security')
    ? (stage as Stage)
    : 'new';
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
