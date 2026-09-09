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
  AssistantToolEntry,
  normalizeThreadStatus,
  proposalItemFromWire,
  normalizeProposalStatus,
  type CardProposal,
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
  /** Thread id → (parentId → the active child id) for branch navigation. */
  private readonly branchChoices = signal<ReadonlyMap<string, ReadonlyMap<string, string>>>(new Map());
  /** The thread's work proposals (Phase 8), keyed by proposal id. */
  private readonly proposalsSignal = signal<ReadonlyMap<string, CardProposal>>(new Map());

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
  /** The active thread's proposals, newest first (discarded ones drop out). */
  readonly proposals = computed(() => {
    const threadId = this.activeThreadIdSignal() ?? '';
    return [...this.proposalsSignal().values()]
      .filter((proposal) => proposal.threadId === threadId && proposal.status !== 'DISCARDED')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
  /** The proposal awaiting confirmation, if any. */
  readonly draftProposal = computed(() => this.proposals().find((proposal) => proposal.status === 'DRAFTED') ?? null);
  /**
   * The visible transcript: the active path through the thread's message
   * tree. Edit-and-resend creates sibling branches (immutable lineage);
   * the newest sibling shows by default and `switchBranch` navigates.
   * Transcripts without ids (pre-S21 logs) stay linear.
   */
  readonly messages = computed(() => {
    const thread = this.thread();
    if (!thread) return [];
    return visibleTranscript(thread.messages, this.branchChoices().get(thread.id));
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

  /** Confirms the proposal with the user's edited items (cards land per project). */
  async confirmProposal(proposalId: string, items: CardProposal['items']): Promise<string | null> {
    const response = await this.publish('requestProposalConfirm', { proposalId, items });
    return response.ok ? null : (response.rejectionMessage ?? 'the proposal could not be confirmed');
  }

  async discardProposal(proposalId: string): Promise<string | null> {
    const response = await this.publish('requestProposalDiscard', { proposalId });
    return response.ok ? null : (response.rejectionMessage ?? 'the proposal could not be discarded');
  }

  private upsertProposal(proposal: CardProposal): void {
    this.proposalsSignal.update((proposals) => {
      const next = new Map(proposals);
      next.set(proposal.id, proposal);
      return next;
    });
  }

  async renameThread(threadId: string, name: string): Promise<boolean> {
    const response = await this.publish('requestAssistantThreadRename', { threadId, name });
    if (!response.ok) {
      this.error.set(response.rejectionMessage ?? 'the thread could not be renamed');
      return false;
    }
    return true;
  }

  /**
   * Edit-and-resend: the edited message becomes a sibling of the original
   * (immutable lineage) and a turn runs for it. The send-lock clears on
   * the reply's completion.
   */
  async resendMessage(threadId: string, messageId: string, text: string): Promise<boolean> {
    const value = text.trim();
    if (value === '' || this.isSending()) return false;
    this.error.set(null);
    this.isSending.set(true);
    const response = await this.publish('requestAssistantResend', {
      threadId,
      messageId,
      text: value,
    });
    if (!response.ok) {
      this.isSending.set(false);
      this.error.set(response.rejectionMessage ?? 'the message could not be resent');
      return false;
    }
    return true;
  }

  /** The sibling versions of a forked message (branch navigation). */
  branchOf(threadId: string, message: AssistantMessage): { position: number; count: number } | null {
    if (message.id === '') return null;
    const siblings = visibleSiblings(this.threadsSignal().get(threadId)?.messages ?? [], message.parentId);
    if (siblings.length <= 1) return null;
    return { position: siblings.findIndex((entry) => entry.id === message.id) + 1, count: siblings.length };
  }

  /** Shows the given sibling of a forked message (the subtree below follows). */
  switchBranch(threadId: string, parentId: string | null, childId: string): void {
    const key = parentId ?? '';
    this.branchChoices.update((choices) => {
      const forThread = new Map(choices.get(threadId) ?? new Map());
      forThread.set(key, childId);
      const next = new Map(choices);
      next.set(threadId, forThread);
      return next;
    });
  }

  private openStreamingBubble(threadId: string, message: AssistantMessage): void {
    if (threadId === this.activeThreadIdSignal()) {
      this.streamingMessage.set(
        new AssistantMessage({ index: message.index + 1, role: 'agent', text: '' }),
      );
    }
  }

  /** requestAssistantMessage; the reply arrives on the stream. */
  async sendMessage(text: string, projectIds?: readonly string[]): Promise<boolean> {
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
    const parent = this.messages().at(-1);
    const response = await this.publish('requestAssistantMessage', {
      threadId: thread.id,
      text: value,
      ...(parent?.id ? { parentId: parent.id } : {}),
      ...(projectIds !== undefined ? { projectIds: [...projectIds] } : {}),
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
        this.openStreamingBubble(payload.threadId, message);
        break;
      }
      case 'assistantResent': {
        // The edited message opens a sibling branch; it is the turn's parent.
        const payload = event.assistantResent;
        if (!payload?.threadId || !payload.message) break;
        const message = asMessage(payload.message);
        this.upsertMessage(payload.threadId, message, 'RUNNING');
        // The new branch becomes the visible one (its sibling stays navigable).
        if (message.id !== '') {
          this.switchBranch(payload.threadId, message.parentId, message.id);
        }
        this.openStreamingBubble(payload.threadId, message);
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
        const status = message.activity
          ? 'RUNNING'
          : current === 'STOPPED' || current === 'FAILED'
            ? current
            : 'IDLE';
        this.upsertMessage(payload.threadId, message, status);
        // The completion clears the live stream for the active thread (the
        // assistant is single-writer per thread).
        if (!message.activity && payload.threadId === this.activeThreadIdSignal()) {
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
      }      case 'assistantThreadStatusChanged': {
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
      case 'assistantToolCall': {
        // The working box (S25): the turn's tool activity, grouped under
        // the user message the turn answers.
        const payload = event.assistantToolCall;
        if (!payload?.threadId || !payload.toolCallId) break;
        this.appendToolCall(payload.threadId, {
          toolCallId: payload.toolCallId,
          parentId: payload.parentId ?? null,
          toolName: payload.toolName ?? '',
          args: payload.args,
        });
        break;
      }
      case 'assistantToolResult': {
        const payload = event.assistantToolResult;
        if (!payload?.threadId || !payload.toolCallId) break;
        this.settleToolCall(
          payload.threadId,
          payload.toolCallId,
          payload.summary ?? '',
          payload.isError === true,
        );
        break;
      }
      case 'proposalDrafted': {
        const payload = event.proposalDrafted;
        const proposal = payload?.proposal;
        if (!proposal?.id) break;
        this.upsertProposal({
          id: proposal.id,
          threadId: proposal.threadId ?? '',
          createdAt: proposal.createdAt ?? '',
          status: normalizeProposalStatus(proposal.status as string | undefined),
          items: (proposal.items ?? []).map(proposalItemFromWire),
        });
        break;
      }
      case 'proposalConfirmed': {
        const payload = event.proposalConfirmed;
        if (!payload?.proposalId) break;
        this.proposalsSignal.update((proposals) => {
          const existing = proposals.get(payload.proposalId);
          if (!existing) return proposals;
          const next = new Map(proposals);
          next.set(payload.proposalId, {
            ...existing,
            status: 'CONFIRMED',
            items: (payload.items ?? []).map(proposalItemFromWire),
            outcomes: (payload.outcomes ?? []).map((outcome) => ({
              projectId: outcome.projectId ?? '',
              ok: outcome.ok === true,
              cardIds: outcome.cardIds ?? [],
              error: outcome.error,
            })),
            confirmedAt: payload.confirmedAt ?? '',
          });
          return next;
        });
        break;
      }
      case 'proposalDiscarded': {
        const payload = event.proposalDiscarded;
        if (!payload?.proposalId) break;
        this.proposalsSignal.update((proposals) => {
          const existing = proposals.get(payload.proposalId);
          if (!existing) return proposals;
          const next = new Map(proposals);
          next.set(payload.proposalId, { ...existing, status: 'DISCARDED' });
          return next;
        });
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

  /** The call creates the working-box entry; idempotent by toolCallId. */
  private appendToolCall(threadId: string, entry: AssistantToolEntry): void {
    this.threadsSignal.update((threads) => {
      const existing = threads.get(threadId);
      if (!existing || existing.toolCalls.some((tool) => tool.toolCallId === entry.toolCallId)) {
        return threads;
      }
      const next = existing.withToolCalls([...existing.toolCalls, entry]);
      const map = new Map(threads);
      map.set(threadId, next);
      return map;
    });
  }

  /** The result settles the entry's summary in place (the server capped it). */
  private settleToolCall(threadId: string, toolCallId: string, summary: string, isError: boolean): void {
    this.threadsSignal.update((threads) => {
      const existing = threads.get(threadId);
      if (!existing || !existing.toolCalls.some((tool) => tool.toolCallId === toolCallId)) {
        return threads;
      }
      const settled = existing.withToolCalls(
        existing.toolCalls.map((tool) =>
          tool.toolCallId === toolCallId
            ? { ...tool, summary, isError: isError || undefined }
            : tool,
        ),
      );
      const map = new Map(threads);
      map.set(threadId, settled);
      return map;
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
        toolCalls: existing.toolCalls,
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
               id: message.id,
               parentId: message.parentId ?? undefined,
               activity: message.activity,
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
        toolCalls: thread.toolCalls,
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
    toolCalls: Array.isArray(value['toolCalls']) ? (value['toolCalls'] as never[]) : [],
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
    id: typeof record['id'] === 'string' ? record['id'] : undefined,
    parentId: typeof record['parentId'] === 'string' ? record['parentId'] : undefined,
    activity: record['activity'] === true,
  });
}

// ---- Branch lineage (the visible transcript) ----

/** The siblings of one fork point, in log order. */
function visibleSiblings(
  messages: readonly AssistantMessage[],
  parentId: string | null,
): AssistantMessage[] {
  return messages
    .filter((message) => !message.activity && message.parentId === parentId)
    .sort((a, b) => a.index - b.index);
}

/**
 * The active path through the message tree: from the root, at every fork
 * follow the chosen child (default the newest). Transcripts without ids
 * (pre-S21 logs) render linearly, deduped by (role, index).
 */
function visibleTranscript(
  messages: readonly AssistantMessage[],
  choices: ReadonlyMap<string, string> | undefined,
): AssistantMessage[] {
  const transcript = messages.filter((message) => !message.activity);
  if (transcript.length === 0) return [];
  if (transcript.some((message) => message.id === '')) {
    const seen = new Map<string, AssistantMessage>();
    for (const message of [...transcript].sort((a, b) => a.index - b.index)) {
      seen.set(`${message.role}-${message.index}`, message);
    }
    return [...seen.values()];
  }
  const path: AssistantMessage[] = [];
  let parentId: string | null = null;
  for (;;) {
    const siblings: AssistantMessage[] = visibleSiblings(transcript, parentId);
    if (siblings.length === 0) break;
    const chosen: string | undefined = choices?.get(parentId ?? '');
    const node: AssistantMessage =
      siblings.find((entry) => entry.id === chosen) ?? siblings[siblings.length - 1]!;
    path.push(node);
    parentId = node.id;
  }
  return path;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item !== '')
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
