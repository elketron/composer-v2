import { Injectable, computed, inject, signal } from '@angular/core';

import { EventsClient } from '../core/events/events-client';
import {
  DomainEventJson,
  PublishRequestJson,
  PublishResponseJson,
  domainEventKind,
} from '../core/events/wire';
import {
  AssistantMessage,
  AssistantThread,
  normalizeThreadStatus,
  type AssistantThreadStatus,
} from '../core/models/assistant.models';

/**
 * Global assistant threads (Phase 6): a fold of the assistant event family
 * (assistantThreadCreated/Archived/Restored/ScopeChanged,
 * assistantUserMessage, assistantMessageDelta/Complete) with commands over
 * publish. The assistant runs server-side; this service folds its events
 * and publishes the user's messages. Threads are global — no project scope
 * on the wire; the scope rides the thread's projectIds.
 *
 * Thread creation is awaited on the first send (the echo selects the
 * thread), mirroring the planning session's lazy create.
 */
@Injectable({ providedIn: 'root' })
export class AssistantService {
  private static readonly SEEN_IDS_CAP = 4096;

  private readonly events = inject(EventsClient);

  private readonly threadsSignal = signal<ReadonlyMap<string, AssistantThread>>(new Map());
  private readonly activeThreadIdSignal = signal<string | null>(null);
  private readonly pendingCreate = new Set<string>();
  private readonly seenEventIds = new Map<string, true>();

  readonly threads = this.threadsSignal.asReadonly();
  readonly activeThreadId = this.activeThreadIdSignal.asReadonly();
  readonly activeThreads = computed(() =>
    [...this.threadsSignal().values()]
      .filter((thread) => thread.isActive)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );
  readonly archivedThreads = computed(() =>
    [...this.threadsSignal().values()]
      .filter((thread) => !thread.isActive)
      .sort((b, a) => b.createdAt.localeCompare(a.createdAt)),
  );
  readonly thread = computed(
    () => this.threadsSignal().get(this.activeThreadIdSignal() ?? '') ?? null,
  );
  readonly messages = computed(() => {
    const messages = this.thread()?.messages ?? [];
    // Re-delivered events can land the same slot twice; each (role, index)
    // renders once — the latest write wins.
    const seen = new Map<string, AssistantMessage>();
    for (const message of messages) {
      seen.set(`${message.role}-${message.index}`, message);
    }
    return [...seen.values()];
  });
  readonly streamingMessage = signal<AssistantMessage | null>(null);
  readonly isSending = signal(false);
  readonly error = signal<string | null>(null);
  readonly commands = signal<readonly string[]>([]);

  constructor() {
    this.events.events$.subscribe((event) => this.applyEvent(event));
  }

  select(threadId: string | null): void {
    this.activeThreadIdSignal.set(threadId);
    this.streamingMessage.set(null);
    this.error.set(null);
  }

  /** Creates a thread (optionally named); the echo selects it. */
  async createThread(name?: string): Promise<boolean> {
    this.error.set(null);
    // Armed before the publish: the echo can't precede the POST response.
    this.pendingCreate.add('*');
    const response = await this.publish('requestAssistantThreadCreate', {
      ...(name !== undefined && name.trim() !== '' ? { name: name.trim() } : {}),
    });
    if (!response.ok) {
      this.pendingCreate.clear();
      this.error.set(response.rejectionMessage ?? 'the thread could not be created');
      return false;
    }
    return true;
  }

  async archiveThread(threadId: string): Promise<string | null> {
    const response = await this.publish('requestAssistantThreadArchive', { threadId });
    return response.ok ? null : (response.rejectionMessage ?? 'the thread could not be archived');
  }

  async restoreThread(threadId: string): Promise<string | null> {
    const response = await this.publish('requestAssistantThreadRestore', { threadId });
    return response.ok ? null : (response.rejectionMessage ?? 'the thread could not be restored');
  }

  /** Replaces the thread's project scope wholesale. */
  async setScope(threadId: string, projectIds: readonly string[]): Promise<boolean> {
    const response = await this.publish('requestAssistantThreadScope', {
      threadId,
      projectIds: [...projectIds],
    });
    if (!response.ok) {
      this.error.set(response.rejectionMessage ?? 'the scope could not be saved');
      return false;
    }
    return true;
  }

  /** Stops the running response; the partial reply lands on the stream. */
  async stopThread(threadId: string): Promise<void> {
    const response = await this.publish('requestAssistantThreadStop', { threadId });
    if (!response.ok) this.error.set(response.rejectionMessage ?? 'the thread could not be stopped');
  }

  /** Re-runs the thread's last user message (an alternate response appends). */
  async retryThread(threadId: string): Promise<void> {
    if (this.isSending()) return;
    this.error.set(null);
    this.isSending.set(true);
    const response = await this.publish('requestAssistantRetry', { threadId });
    if (!response.ok) {
      this.isSending.set(false);
      this.error.set(response.rejectionMessage ?? 'the thread could not be retried');
    }
  }

  async renameThread(threadId: string, name: string): Promise<boolean> {
    const response = await this.publish('requestAssistantThreadRename', { threadId, name });
    if (!response.ok) {
      this.error.set(response.rejectionMessage ?? 'the thread could not be renamed');
      return false;
    }
    return true;
  }

  /** requestAssistantMessage; the reply arrives on the stream. */
  async sendMessage(text: string): Promise<boolean> {
    const value = text.trim();
    if (!value || this.isSending()) return false;

    this.error.set(null);
    this.isSending.set(true);
    const thread = this.thread() ?? (await this.createThreadForSend());
    if (!thread) {
      this.isSending.set(false);
      this.error.set('could not start a thread');
      return false;
    }
    if (thread.id !== this.activeThreadIdSignal()) this.select(thread.id);
    const response = await this.publish('requestAssistantMessage', {
      threadId: thread.id,
      text: value,
    });
    if (!response.ok) {
      this.isSending.set(false);
      this.error.set(response.rejectionMessage ?? 'message rejected');
      return false;
    }
    return true;
  }

  applyEvent(event: DomainEventJson): void {
    if (event.id) {
      if (this.seenEventIds.has(event.id)) return;
      this.seenEventIds.set(event.id, true);
      if (this.seenEventIds.size > AssistantService.SEEN_IDS_CAP) {
        const oldest = this.seenEventIds.keys().next().value;
        if (oldest !== undefined) this.seenEventIds.delete(oldest);
      }
    }

    switch (domainEventKind(event)) {
      case 'assistantThreadCreated': {
        const incoming = asThread(event.assistantThreadCreated?.thread);
        if (!incoming) break;
        this.upsertThread(incoming);
        // The deliberate create (or the very first thread) selects itself.
        if (this.pendingCreate.size > 0 || this.activeThreadIdSignal() === null) {
          this.pendingCreate.clear();
          this.activeThreadIdSignal.set(incoming.id);
        }
        break;
      }
      case 'assistantThreadArchived': {
        const payload = event.assistantThreadArchived;
        if (!payload?.threadId) break;
        this.updateThread(payload.threadId, { archivedAt: payload.archivedAt ?? null });
        if (this.activeThreadIdSignal() === payload.threadId) {
          const next = this.activeThreads()[0]?.id ?? null;
          this.activeThreadIdSignal.set(next);
          this.streamingMessage.set(null);
        }
        break;
      }
      case 'assistantThreadRestored': {
        const payload = event.assistantThreadRestored;
        if (!payload?.threadId) break;
        this.updateThread(payload.threadId, { archivedAt: null });
        break;
      }
      case 'assistantThreadScopeChanged': {
        const payload = event.assistantThreadScopeChanged;
        if (!payload?.threadId) break;
        this.updateThread(payload.threadId, { projectIds: [...(payload.projectIds ?? [])] });
        break;
      }
      case 'assistantUserMessage': {
        const payload = event.assistantUserMessage;
        if (!payload?.threadId || !payload.message) break;
        const message = asMessage(payload.message);
        this.upsertMessage(payload.threadId, message, 'RUNNING');
        if (payload.threadId === this.activeThreadIdSignal()) {
          this.streamingMessage.set(new AssistantMessage({ index: message.index + 1, role: 'agent', text: '' }));
        }
        break;
      }
      case 'assistantMessageDelta': {
        const payload = event.assistantMessageDelta;
        if (!payload?.threadId || payload.threadId !== this.activeThreadIdSignal()) break;
        const current = this.streamingMessage();
        const message =
          current?.index === payload.messageIndex
            ? new AssistantMessage({ index: current.index, role: 'agent', text: current.text + payload.delta })
            : new AssistantMessage({ index: payload.messageIndex, role: 'agent', text: payload.delta });
        this.streamingMessage.set(message);
        break;
      }
      case 'assistantMessageComplete': {
        const payload = event.assistantMessageComplete;
        if (!payload?.threadId || !payload.message) break;
        const message = asMessage(payload.message);
        // The reply closes the turn — but never un-marks a stopped or
        // failed thread (the stop's partial completion lands here too).
        const current = this.threadsSignal().get(payload.threadId)?.status;
        const status = current === 'STOPPED' || current === 'FAILED' ? current : 'IDLE';
        this.upsertMessage(payload.threadId, message, status);
        // The completion clears the live stream for the active thread (the
        // assistant is single-writer per thread).
        if (payload.threadId === this.activeThreadIdSignal()) {
          this.streamingMessage.set(null);
          this.isSending.set(false);
        }
        break;
      }
      case 'assistantThreadStopped': {
        const payload = event.assistantThreadStopped;
        if (!payload?.threadId) break;
        this.updateThread(payload.threadId, { status: 'STOPPED' });
        if (payload.threadId === this.activeThreadIdSignal()) {
          this.streamingMessage.set(null);
          this.isSending.set(false);
        }
        break;
      }
      case 'assistantRetryRequested': {
        const payload = event.assistantRetryRequested;
        if (!payload?.threadId) break;
        this.updateThread(payload.threadId, { status: 'RUNNING' });
        if (payload.threadId === this.activeThreadIdSignal()) {
          this.isSending.set(true);
          const next = (this.thread()?.messages.at(-1)?.index ?? 0) + 1;
          this.streamingMessage.set(new AssistantMessage({ index: next, role: 'agent', text: '' }));
        }
        break;
      }
      case 'assistantThreadStatusChanged': {
        const payload = event.assistantThreadStatusChanged;
        if (!payload?.threadId) break;
        this.updateThread(payload.threadId, {
          status: normalizeThreadStatus(payload.status as string | undefined),
        });
        break;
      }
      case 'assistantThreadRenamed': {
        const payload = event.assistantThreadRenamed;
        if (!payload?.threadId) break;
        this.updateThread(payload.threadId, { name: payload.name ?? '' });
        break;
      }
    }
  }

  // ---- Internals ----

  /** The active thread for a send, creating one when none is selected. */
  private createThreadForSend(): Promise<AssistantThread | null> {
    const promise = new Promise<AssistantThread | null>((resolve) => {
      const timer = setTimeout(() => finish(null), 10_000);
      const subscription = this.events.events$.subscribe((event) => {
        if (domainEventKind(event) === 'assistantThreadCreated') {
          const id = event.assistantThreadCreated?.thread?.id;
          if (typeof id === 'string') finish(this.threadsSignal().get(id) ?? null);
        }
      });
      const finish = (thread: AssistantThread | null) => {
        clearTimeout(timer);
        subscription.unsubscribe();
        resolve(thread);
      };
      void this.publish('requestAssistantThreadCreate', {}).then((response) => {
        if (!response.ok) finish(null);
      });
    });
    return promise;
  }

  private upsertThread(thread: AssistantThread): void {
    this.threadsSignal.update((threads) => {
      const next = new Map(threads);
      next.set(thread.id, thread);
      return next;
    });
  }

  private updateThread(
    threadId: string,
    changes: { archivedAt?: string | null; projectIds?: string[]; status?: AssistantThreadStatus; name?: string },
  ): void {
    this.threadsSignal.update((threads) => {
      const existing = threads.get(threadId);
      if (!existing) return threads;
      const next = new AssistantThread({
        id: existing.id,
        name: changes.name ?? existing.name,
        createdAt: existing.createdAt,
        status: changes.status ?? existing.status,
        projectIds: changes.projectIds ?? existing.projectIds,
        archivedAt: changes.archivedAt !== undefined ? changes.archivedAt : existing.archivedAt,
        messages: existing.messages,
      });
      const map = new Map(threads);
      map.set(threadId, next);
      return map;
    });
  }

  private upsertMessage(threadId: string, message: AssistantMessage, status: string): void {
    this.threadsSignal.update((threads) => {
      const existing = threads.get(threadId);
      const thread =
        existing ??
        new AssistantThread({ id: threadId, createdAt: new Date().toISOString() });
      // A message never steals a slot the opposite role already holds (the
      // server's fold heals the same way): the latecomer lands at the end.
      const occupant = thread.messages.find((entry) => entry.index === message.index);
      const healed =
        occupant !== undefined && occupant.role !== message.role
          ? new AssistantMessage({
              index: thread.messages.reduce((max, entry) => Math.max(max, entry.index), 0) + 1,
              role: message.role,
              text: message.text,
              at: message.at,
            })
          : message;
      const messages = thread.messages.filter((entry) => entry.index !== healed.index);
      messages.push(healed);
      messages.sort((a, b) => a.index - b.index);
      const next = new AssistantThread({
        id: thread.id,
        name: thread.name,
        createdAt: thread.createdAt,
        status,
        projectIds: thread.projectIds,
        archivedAt: thread.archivedAt,
        messages,
      });
      const map = new Map(threads);
      map.set(threadId, next);
      return map;
    });
  }

  private publish(command: string, payload: Record<string, unknown>): Promise<PublishResponseJson> {
    this.commands.update((commands) => [...commands.slice(-99), command]);
    const request = { projectId: '', [command]: payload } as unknown as PublishRequestJson;
    return this.events.publish(request);
  }
}

// ---- Event payload coercion ----

function asThread(value: unknown): AssistantThread | null {
  if (value instanceof AssistantThread) return value;
  if (!isRecord(value) || typeof value['id'] !== 'string') return null;
  return new AssistantThread({
    id: value['id'],
    name: typeof value['name'] === 'string' ? value['name'] : '',
    createdAt: typeof value['createdAt'] === 'string' ? value['createdAt'] : undefined,
    status: normalizeThreadStatus(value['status'] as string | undefined),
    projectIds: arrayOfStrings(value['projectIds']),
    archivedAt: typeof value['archivedAt'] === 'string' ? value['archivedAt'] : null,
    messages: Array.isArray(value['messages']) ? (value['messages'] as never[]) : [],
  });
}

function asMessage(value: unknown): AssistantMessage {
  if (value instanceof AssistantMessage) return value;
  const record = isRecord(value) ? value : {};
  return new AssistantMessage({
    index: typeof record['index'] === 'number' ? record['index'] : 0,
    role: typeof record['role'] === 'string' ? record['role'] : 'user',
    text: typeof record['text'] === 'string' ? record['text'] : '',
    at: typeof record['at'] === 'string' ? record['at'] : undefined,
  });
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item !== '')
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
