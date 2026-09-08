// The global assistant thread's transitions: the thread owns the rules
// that govern what may happen to it — archive/restore idempotence, an open
// (non-archived) thread for conversation, one running turn at a time, the
// user message's index — answering commands with the canonical events to
// publish or a typed rejection.

import { randomUUID } from 'node:crypto';
import type { AssistantThread, ChatMessage, Project } from '../wire/models.js';
import { nowIso } from '../wire/envelope.js';
import { CommandRejection, event, type PendingEvent } from './rejection.js';

export class Thread {
  private constructor(private readonly thread: AssistantThread) {}

  static of(thread: AssistantThread): Thread {
    return new Thread(thread);
  }

  /** Archived threads reject scope edits (restore first — but scope says just "archived"). */
  requireNotArchived(): void {
    if (this.thread.archivedAt !== undefined) {
      throw new CommandRejection('invalidCommand', `Thread ${this.thread.id} is archived`);
    }
  }

  /** Conversation commands need an open thread. */
  requireOpen(): void {
    if (this.thread.archivedAt !== undefined) {
      throw new CommandRejection('invalidCommand', `Thread ${this.thread.id} is archived; restore it first`);
    }
  }

  /** Archive is idempotent: an already-archived thread publishes nothing. */
  archiveEvents(): PendingEvent[] {
    if (this.thread.archivedAt !== undefined) return [];
    return [event('assistantThreadArchived', { threadId: this.thread.id, archivedAt: nowIso() })];
  }

  /** Restore is idempotent: an open thread publishes nothing. */
  restoreEvents(): PendingEvent[] {
    if (this.thread.archivedAt === undefined) return [];
    return [event('assistantThreadRestored', { threadId: this.thread.id, restoredAt: nowIso() })];
  }

  /**
   * Replaces the project scope wholesale: every project must exist and be
   * active, duplicates collapse preserving order.
   */
  scopeEvents(projectIds: string[], resolveProject: (id: string) => Project | undefined): PendingEvent[] {
    this.requireNotArchived();
    const seen = new Set<string>();
    const scoped: string[] = [];
    for (const projectId of projectIds) {
      if (projectId === '' || seen.has(projectId)) continue;
      const project = resolveProject(projectId);
      if (!project) {
        throw new CommandRejection('unknownProject', `Unknown project ${projectId}`);
      }
      if (project.archivedAt !== undefined) {
        throw new CommandRejection('invalidCommand', `Project ${projectId} is archived`);
      }
      seen.add(projectId);
      scoped.push(projectId);
    }
    return [event('assistantThreadScopeChanged', { threadId: this.thread.id, projectIds: scoped })];
  }

  /** Appends a user message; the index lands past every folded message. */
  messageEvents(text: string): PendingEvent[] {
    this.requireOpen();
    if (text.trim() === '') {
      throw new CommandRejection('invalidCommand', 'Message text is required');
    }
    const message: ChatMessage = {
      id: randomUUID(),
      index: this.nextMessageIndex(),
      role: 'user',
      text,
      at: nowIso(),
    };
    return [event('assistantUserMessage', { threadId: this.thread.id, message })];
  }

  /**
   * Edit-and-resend: the edited user message becomes a sibling of the
   * original (same `parentId`, fresh id and index) — the prior branch
   * stays intact.
   */
  resendEvents(messageId: string, text: string): PendingEvent[] {
    this.requireOpen();
    if (text.trim() === '') {
      throw new CommandRejection('invalidCommand', 'Message text is required');
    }
    const original = this.thread.messages.find((message) => message.id === messageId);
    if (original === undefined) {
      throw new CommandRejection('unknownSession', `Unknown message ${messageId}`);
    }
    if (this.thread.status === 'running') {
      throw new CommandRejection('invalidCommand', `Thread ${this.thread.id} is already running`);
    }
    if (original.role !== 'user') {
      throw new CommandRejection('invalidCommand', 'Only a user message can be edited and resent');
    }
    const message: ChatMessage = {
      id: randomUUID(),
      ...(original.parentId !== undefined ? { parentId: original.parentId } : {}),
      index: this.nextMessageIndex(),
      role: 'user',
      text,
      at: nowIso(),
    };
    return [event('assistantResent', { threadId: this.thread.id, message })];
  }

  /** Stops a running response; the fold marks the thread `stopped`. */
  stopEvents(): PendingEvent[] {
    if (this.thread.status !== 'running') {
      throw new CommandRejection('invalidCommand', `Thread ${this.thread.id} is not running`);
    }
    return [event('assistantThreadStopped', { threadId: this.thread.id })];
  }

  /** Re-runs the thread's last user message; nothing in the transcript is rewritten. */
  retryEvents(): PendingEvent[] {
    this.requireOpen();
    if (this.thread.status === 'running') {
      throw new CommandRejection('invalidCommand', `Thread ${this.thread.id} is already running`);
    }
    const lastUser = [...this.thread.messages].reverse().find((message) => message.role === 'user');
    if (lastUser === undefined) {
      throw new CommandRejection('invalidCommand', `Thread ${this.thread.id} has no user message to retry`);
    }
    return [event('assistantRetryRequested', { threadId: this.thread.id })];
  }

  /** Renames the thread; a same-name rename is a no-op. */
  renameEvents(name: string): PendingEvent[] {
    this.requireOpen();
    const trimmed = name.trim();
    if (trimmed === '') {
      throw new CommandRejection('invalidCommand', 'Thread name is required');
    }
    if (trimmed === this.thread.name) return [];
    return [event('assistantThreadRenamed', { threadId: this.thread.id, name: trimmed })];
  }

  /** Whether a proposal item's project is in the thread's scope. */
  requireInScope(projectId: string): void {
    if (!this.thread.projectIds.includes(projectId)) {
      throw new CommandRejection(
        'invalidCommand',
        `project ${projectId} is not in thread ${this.thread.id}'s scope`,
      );
    }
  }

  /** One past the highest message index (v1 `next_message_index`; starts at 1). */
  nextMessageIndex(): number {
    return this.thread.messages.reduce((max, message) => Math.max(max, message.index), 0) + 1;
  }
}
