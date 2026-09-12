import { Injectable, computed, inject, signal } from '@angular/core';

import { EventsClient } from '../core/events/events-client';
import { EventDeduper } from '../core/events/dedupe-events';
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
import { Assignee, Card, CardType } from '../core/models/board.models';

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

  private readonly events = inject(EventsClient);
  private readonly dedupe = new EventDeduper();

  private readonly sessionsSignal = signal<ReadonlyMap<string, PlanningSession>>(new Map());
  private readonly streamingMessagesSignal = signal<ReadonlyMap<string, ChatMessage>>(new Map());
  private readonly sendingProjectsSignal = signal<ReadonlySet<string>>(new Set());
  private readonly committedCardsSignal = signal<ReadonlyMap<string, readonly Card[]>>(new Map());
  private readonly activeProjectSignal = signal<string | null>(null);
  private readonly pendingSessions = new Map<string, Promise<PlanningSession | null>>();
  /** Projects with a deliberate session-create in flight (the echo replaces). */
  private readonly pendingCreate = new Set<string>();

  readonly sessions = this.sessionsSignal.asReadonly();
  readonly projectId = this.activeProjectSignal.asReadonly();
  readonly session = computed(() => {
    const projectId = this.activeProjectSignal();
    return projectId ? (this.sessionsSignal().get(projectId) ?? null) : null;
  });
  readonly messages = computed(() => {
    const messages = (this.session()?.messages ?? []).filter((message) => !message.activity);
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
  readonly streamingMessage = computed(() => {
    const projectId = this.activeProjectSignal();
    return projectId ? (this.streamingMessagesSignal().get(projectId) ?? null) : null;
  });
  readonly isSending = computed(() => {
    const projectId = this.activeProjectSignal();
    return projectId !== null && this.sendingProjectsSignal().has(projectId);
  });
  readonly loading = this.isSending;
  readonly error = signal<string | null>(null);
  readonly committedCards = computed(() => {
    const projectId = this.activeProjectSignal();
    return projectId ? (this.committedCardsSignal().get(projectId) ?? []) : [];
  });
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
    this.error.set(null);
  }

  /** RequestUserMessage; the planner's answer arrives on the stream. */
  async sendMessage(text: string): Promise<boolean> {
    const value = text.trim();
    const projectId = this.activeProjectSignal();
    if (!value || !projectId || this.isSending()) return false;

    this.error.set(null);
    this.setProjectSending(projectId, true);
    const session = this.session() ?? (await this.createSession(projectId));
    if (!session) {
      this.setProjectSending(projectId, false);
      this.error.set('could not start a planning session');
      return false;
    }
    const response = await this.publishCommand({
      type: 'RequestUserMessage',
      projectId,
      sessionId: session.id,
      text: value,
    });
    if (!response.ok) {
      this.setProjectSending(projectId, false);
      this.error.set(response.rejectionMessage ?? 'message rejected');
      return false;
    }
    return true;
  }

  requestUserMessage(text: string): Promise<boolean> {
    return this.sendMessage(text);
  }

  /**
   * Starts a fresh session for the project, replacing the current one (a
   * completed session's transcript is closed — this is how the next
   * milestone gets planned). The echo is accepted even though the old
   * session was populated: we asked for it.
   */
  requestNewSession(): void {
    const projectId = this.activeProjectSignal();
    if (!projectId) return;
    this.pendingCreate.add(projectId);
    this.setProjectStreamingMessage(projectId, null);
    this.setProjectSending(projectId, false);
    this.error.set(null);
    void this.publishCommand({ type: 'RequestPlanningSessionCreate', projectId });
  }

  applyServerEvent(event: PlanEvent): void {
    this.applyEvent(event);
  }

  applyEvent(event: PlanEvent): void {
    if (!this.dedupe.first(event)) return;
    switch (event.type) {
      case 'PlanningSessionCreated': {
        const incoming = asSession(event.session);
        const existing = this.sessionsSignal().get(incoming.projectId);
        // A deliberate new session replaces the current one (the fold's
        // clobber-guard is for stale replays, not for what we asked for).
        if (this.pendingCreate.has(incoming.projectId)) {
          this.pendingCreate.delete(incoming.projectId);
          this.setProjectSession(incoming.projectId, incoming);
          break;
        }
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
        if (!this.isPlanningSession(event.projectId, event.sessionId)) break;
        const message = asMessage(event.message);
        this.updateProjectSession(event.projectId, (session) =>
          session.with({ messages: upsertMessage(session.messages, message) }),
        );
        this.setProjectStreamingMessage(
          event.projectId,
          new ChatMessage({ index: message.index + 1, role: 'agent', text: '' }),
        );
        break;
      }
      case 'AgentMessageDelta': {
        // Agent-step messages (card sessions, A-*) are the pipeline run
        // view's; only known planning sessions fold here — a coder's
        // stream must never replace the plan session.
        if (!this.isPlanningSession(event.projectId, event.sessionId)) break;
        const current = this.streamingMessagesSignal().get(event.projectId);
        const message =
          current?.index === event.messageIndex
            ? current.with({ text: current.text + event.delta })
            : new ChatMessage({ index: event.messageIndex, role: 'agent', text: event.delta });
        this.setProjectStreamingMessage(event.projectId, message);
        break;
      }
      case 'AgentMessageComplete': {
        if (!this.isPlanningSession(event.projectId, event.sessionId)) break;
        const message = asMessage(event.message);
        this.updateProjectSession(event.projectId, (session) =>
          session.with({ messages: upsertMessage(session.messages, message) }),
        );
        // The completion's index can disagree with the deltas' numbering
        // (observed off-by-one), so key the match on "a live stream for the
        // project session ended" — the planner is single-writer per session.
        if (!message.activity) {
          this.setProjectStreamingMessage(event.projectId, null);
          this.setProjectSending(event.projectId, false);
        }
        break;
      }
      case 'AgentToolCall': {
        if (!this.isPlanningSession(event.projectId, event.sessionId)) break;
        this.updateProjectSession(event.projectId, (session) => {
          if (session.toolCalls.some((entry) => entry.toolCallId === event.toolCallId)) return session;
          return session.with({
            toolCalls: [
              ...session.toolCalls,
              {
                toolCallId: event.toolCallId,
                parentIndex: event.parentIndex ?? null,
                toolName: event.toolName,
                args: event.args,
              },
            ],
          });
        });
        break;
      }
      case 'AgentToolResult': {
        if (!this.isPlanningSession(event.projectId, event.sessionId)) break;
        this.updateProjectSession(event.projectId, (session) =>
          session.with({
            toolCalls: session.toolCalls.map((entry) =>
              entry.toolCallId === event.toolCallId
                ? { ...entry, summary: event.content, isError: event.isError || undefined }
                : entry,
            ),
          }),
        );
        break;
      }
      case 'PlanDocumentUpdated': {
        if (!this.isPlanningSession(event.projectId, event.sessionId)) break;
        this.updateProjectSession(event.projectId, (session) =>
          session.with({ planDocument: event.document }),
        );
        break;
      }
      case 'PlanningSessionCompleted': {
        if (!this.isPlanningSession(event.projectId, event.sessionId)) break;
        this.updateProjectSession(event.projectId, (session) =>
          session.with({ status: 'DONE' }),
        );
        break;
      }
      case 'CardsCommitted': {
        // The wire mapping coerced the cards already; the fold is a pass-through.
        const cards = event.cards;
        this.committedCardsSignal.update((cardsByProject) => {
          const next = new Map(cardsByProject);
          next.set(event.projectId, cards);
          return next;
        });
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
    const request = {
      projectId: command.projectId,
      [lcfirst(command.type)]: commandPayload(command),
    } as unknown as PublishRequestJson;
    return this.events.publish(request);
  }

  /**
   * True when the id belongs to a planning session this service already
   * folds. Card-bound agent sessions (the runner's A-*) publish the same
   * message event names — they are the pipeline run view's, not the plan's.
   */
  private isPlanningSession(projectId: string, sessionId: string | undefined): boolean {
    return sessionId !== undefined && this.sessionsSignal().get(projectId)?.id === sessionId;
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

  private setProjectStreamingMessage(projectId: string, message: ChatMessage | null): void {
    this.streamingMessagesSignal.update((messages) => {
      const next = new Map(messages);
      if (message) next.set(projectId, message);
      else next.delete(projectId);
      return next;
    });
  }

  private setProjectSending(projectId: string, sending: boolean): void {
    this.sendingProjectsSignal.update((projects) => {
      const next = new Set(projects);
      if (sending) next.add(projectId);
      else next.delete(projectId);
      return next;
    });
  }
}

// ---- Wire mapping ----

/** Map a wire event to a PlanEvent; null for events the plan view ignores. */
function planEventFromWire(event: DomainEventJson): PlanEvent | null {
  const id = event.id;
  const projectId = event.projectId ?? '';
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
            activity: message.activity,
            parentIndex: message.parentIndex,
          })),
          toolCalls: (session.toolCalls ?? []).map((entry) => ({
            toolCallId: entry.toolCallId ?? '',
            parentIndex: entry.parentIndex,
            toolName: entry.toolName ?? '',
            args: entry.args,
            summary: entry.summary,
            isError: entry.isError,
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
        projectId,
        sessionId: payload.sessionId ?? '',
        message: {
          index: payload.message.index ?? 0,
          role: payload.message.role ?? 'user',
          text: payload.message.text ?? '',
          at: payload.message.at,
          activity: payload.message.activity,
          parentIndex: payload.message.parentIndex,
        },
      };
    }
    case 'agentMessageDelta': {
      const payload = event.agentMessageDelta;
      if (!payload) return null;
      return {
        id,
        type: 'AgentMessageDelta',
        projectId,
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
        projectId,
        sessionId: payload.sessionId ?? '',
        message: {
          index: payload.message.index ?? 0,
          role: payload.message.role ?? 'agent',
          text: payload.message.text ?? '',
          at: payload.message.at,
          activity: payload.message.activity,
          parentIndex: payload.message.parentIndex,
        },
      };
    }
    case 'agentToolCall': {
      const payload = event.agentToolCall;
      if (!payload) return null;
      return {
        id,
        type: 'AgentToolCall',
        projectId,
        sessionId: payload.sessionId ?? '',
        toolCallId: payload.toolCallId ?? '',
        parentIndex: payload.parentIndex,
        toolName: payload.toolName ?? '',
        args: payload.args,
      };
    }
    case 'agentToolResult': {
      const payload = event.agentToolResult;
      if (!payload) return null;
      return {
        id,
        type: 'AgentToolResult',
        projectId,
        sessionId: payload.sessionId ?? '',
        toolCallId: payload.toolCallId ?? '',
        content: payload.content ?? '',
        isError: payload.isError === true,
      };
    }
    case 'planDocumentUpdated': {
      const payload = event.planDocumentUpdated;
      if (!payload) return null;
      return {
        id,
        type: 'PlanDocumentUpdated',
        projectId,
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
        projectId,
        sessionId: payload.sessionId ?? '',
      };
    }
    case 'cardsCommitted':
      return {
        id,
        type: 'CardsCommitted',
        projectId,
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

