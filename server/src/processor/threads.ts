// The global assistant thread commands (Phase 6, Phase 7): the thread
// object owns every rule (archive idempotence, the open-thread guard, the
// running-turn guard, message lineage); these handlers resolve the thread
// and run its transitions.

import { randomUUID } from 'node:crypto';
import type { CommandOutcome } from '../wire/commands.js';
import { nowIso } from '../wire/envelope.js';
import type { AssistantThread } from '../wire/models.js';
import { Thread } from '../domain/thread.js';
import { command, allocateId, ok, rejected, type CommandMap } from './helpers.js';
import { transition } from './transition.js';
import type { Processor } from './index.js';

  /** Opens a named thread; an empty name defaults to `Thread N`. */

export async function createAssistantThread(p: Processor, name: string | undefined): Promise<CommandOutcome> {
    const id = allocateId(p.bus.state.assistantThreads.keys(), 'TH');
    const trimmed = name?.trim() ?? '';
    const thread: AssistantThread = {
      id,
      name: trimmed !== '' ? trimmed : `Thread ${id.slice(3)}`,
      createdAt: nowIso(),
      status: 'idle',
      projectIds: [],
      messages: [],
    };
    await p.bus.publish(undefined, 'assistantThreadCreated', { thread });
    return ok();
  }


export async function archiveAssistantThread(p: Processor, threadId: string): Promise<CommandOutcome> {
    const found = findThread(p, threadId);
    if (!found) {
      return rejected('unknownThread', `Unknown thread ${threadId}`);
    }
    return transition(p.bus, undefined, () => Thread.of(found).archiveEvents());
  }


export async function restoreAssistantThread(p: Processor, threadId: string): Promise<CommandOutcome> {
    const found = findThread(p, threadId);
    if (!found) {
      return rejected('unknownThread', `Unknown thread ${threadId}`);
    }
    return transition(p.bus, undefined, () => Thread.of(found).restoreEvents());
  }

  /**
   * Replaces the thread's project scope wholesale: every project must exist
   * and be active (archived projects leave no scope behind), duplicates
   * collapse preserving order. Archived threads reject scope edits —
   * restore first.
   */


  /**
   * Replaces the thread's project scope wholesale: every project must exist
   * and be active (archived projects leave no scope behind), duplicates
   * collapse preserving order. Archived threads reject scope edits —
   * restore first.
   */

export async function setAssistantThreadScope(
    p: Processor,
    threadId: string,
    projectIds: string[],
  ): Promise<CommandOutcome> {
    const found = findThread(p, threadId);
    if (!found) {
      return rejected('unknownThread', `Unknown thread ${threadId}`);
    }
    return transition(p.bus, undefined, () =>
      Thread.of(found).scopeEvents(projectIds, (id) => p.bus.state.projects.get(id)),
    );
  }

  /** Appends a user message to the thread (archived threads are closed). */


  /** Appends a user message to the thread (archived threads are closed). */

export async function assistantMessage(p: Processor, threadId: string, text: string): Promise<CommandOutcome> {
    const found = findThread(p, threadId);
    if (!found) {
      return rejected('unknownThread', `Unknown thread ${threadId}`);
    }
    return transition(p.bus, undefined, () => Thread.of(found).messageEvents(text));
  }

  /**
   * Edit-and-resend (Phase 7): publishes the edited user message as a
   * sibling of the original (same `parentId`, fresh id and index) — the
   * prior branch stays intact and the orchestrator runs a turn for the new
   * message.
   */


  /**
   * Edit-and-resend (Phase 7): publishes the edited user message as a
   * sibling of the original (same `parentId`, fresh id and index) — the
   * prior branch stays intact and the orchestrator runs a turn for the new
   * message.
   */

export async function resendAssistantMessage(
    p: Processor,
    threadId: string,
    messageId: string,
    text: string,
  ): Promise<CommandOutcome> {
    const found = findThread(p, threadId);
    if (!found) {
      return rejected('unknownThread', `Unknown thread ${threadId}`);
    }
    return transition(p.bus, undefined, () => Thread.of(found).resendEvents(messageId, text));
  }

  /**
   * Records the assistant's draft (the propose_cards MCP tool lands here).
   * Everything is validated up front — scope, shape, and dependencies — so
   * the tool result can teach the model before the user ever sees it.
   */


  /**
   * Stops a running response (Phase 7): the canonical record is the
   * orchestrator's kill trigger; the fold marks the thread `stopped`.
   */

export async function stopAssistantThread(p: Processor, threadId: string): Promise<CommandOutcome> {
    const found = findThread(p, threadId);
    if (!found) {
      return rejected('unknownThread', `Unknown thread ${threadId}`);
    }
    return transition(p.bus, undefined, () => Thread.of(found).stopEvents());
  }

  /**
   * Re-runs the thread's last user message (Phase 7): the reply appends an
   * alternate response — nothing in the transcript is rewritten.
   */


  /**
   * Re-runs the thread's last user message (Phase 7): the reply appends an
   * alternate response — nothing in the transcript is rewritten.
   */

export async function retryAssistantThread(p: Processor, threadId: string): Promise<CommandOutcome> {
    const found = findThread(p, threadId);
    if (!found) {
      return rejected('unknownThread', `Unknown thread ${threadId}`);
    }
    return transition(p.bus, undefined, () => Thread.of(found).retryEvents());
  }


export async function renameAssistantThread(p: Processor, threadId: string, name: string): Promise<CommandOutcome> {
    const found = findThread(p, threadId);
    if (!found) {
      return rejected('unknownThread', `Unknown thread ${threadId}`);
    }
    return transition(p.bus, undefined, () => Thread.of(found).renameEvents(name));
  }

  /** The named thread record, or null. */


  /** The named thread record, or null. */

export function findThread(p: Processor, threadId: string): AssistantThread | null {
    return p.assistantThreads().get(threadId) ?? null;
  }


export const threadCommands: CommandMap = [
  command('requestAssistantThreadCreate', (p, _scope, cmd) => createAssistantThread(p, cmd.name)),
  command('requestAssistantThreadArchive', (p, _scope, cmd) => archiveAssistantThread(p, cmd.threadId)),
  command('requestAssistantThreadRestore', (p, _scope, cmd) => restoreAssistantThread(p, cmd.threadId)),
  command('requestAssistantThreadScope', (p, _scope, cmd) => setAssistantThreadScope(p, cmd.threadId, cmd.projectIds)),
  command('requestAssistantMessage', (p, _scope, cmd) => assistantMessage(p, cmd.threadId, cmd.text)),
  command('requestAssistantThreadStop', (p, _scope, cmd) => stopAssistantThread(p, cmd.threadId)),
  command('requestAssistantRetry', (p, _scope, cmd) => retryAssistantThread(p, cmd.threadId)),
  command('requestAssistantThreadRename', (p, _scope, cmd) => renameAssistantThread(p, cmd.threadId, cmd.name)),
  command('requestAssistantResend', (p, _scope, cmd) => resendAssistantMessage(p, cmd.threadId, cmd.messageId, cmd.text)),
];
