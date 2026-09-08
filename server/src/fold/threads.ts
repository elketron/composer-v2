// The global assistant thread domain's fold steps (Phase 6, Phase 7, S25):
// creation, archive/restore, scope, the transcript's message upserts, the
// status marks, renames, and the tool-call working box. Global events —
// no projectId.

import type { AssistantThread, ChatMessage } from '../wire/models.js';
import type { EventEnvelope } from '../wire/envelope.js';
import { upsertTranscriptMessage } from '../domain/transcript.js';
import { readBody, type FoldHandler, type State } from './state.js';

export const threadHandlers: Record<string, FoldHandler> = {
  assistantThreadCreated: (state, envelope) => {
    const body = readBody(envelope, 'assistantThreadCreated');
    state.assistantThreads.set(body.thread.id, structuredClone(body.thread));
  },
  assistantThreadArchived: (state, envelope) => {
    const body = readBody(envelope, 'assistantThreadArchived');
    const thread = state.assistantThreads.get(body.threadId);
    if (thread) thread.archivedAt = body.archivedAt;
  },
  assistantThreadRestored: (state, envelope) => {
    const body = readBody(envelope, 'assistantThreadRestored');
    const thread = state.assistantThreads.get(body.threadId);
    if (thread) delete thread.archivedAt;
  },
  assistantThreadScopeChanged: (state, envelope) => {
    const body = readBody(envelope, 'assistantThreadScopeChanged');
    const thread = state.assistantThreads.get(body.threadId);
    if (thread) thread.projectIds = [...body.projectIds];
  },
  assistantUserMessage: userMessageFold,
  assistantResent: userMessageFold,
  assistantMessageComplete: (state, envelope) => {
    const body = readBody(envelope, 'assistantMessageComplete');
    const thread = state.assistantThreads.get(body.threadId);
    if (!thread) return;
    foldThreadMessage(thread, body.message);
    // The reply closes the turn — but never un-marks a stopped or failed
    // thread (the stop's partial completion and the failure message both
    // land through this event).
    if (thread.status === 'running') thread.status = 'idle';
  },
  assistantThreadStopped: (state, envelope) => {
    const body = readBody(envelope, 'assistantThreadStopped');
    const thread = state.assistantThreads.get(body.threadId);
    if (thread) thread.status = 'stopped';
  },
  assistantRetryRequested: (state, envelope) => {
    const body = readBody(envelope, 'assistantRetryRequested');
    const thread = state.assistantThreads.get(body.threadId);
    if (thread) thread.status = 'running';
  },
  assistantThreadStatusChanged: (state, envelope) => {
    const body = readBody(envelope, 'assistantThreadStatusChanged');
    const thread = state.assistantThreads.get(body.threadId);
    if (thread) thread.status = body.status;
  },
  assistantThreadRenamed: (state, envelope) => {
    const body = readBody(envelope, 'assistantThreadRenamed');
    const thread = state.assistantThreads.get(body.threadId);
    if (thread) thread.name = body.name;
  },
  assistantToolCall: (state, envelope) => {
    // The working box (S25): the call creates the entry; idempotent by
    // toolCallId. Old logs' threads have no toolCalls — added here.
    const body = readBody(envelope, 'assistantToolCall');
    const thread = state.assistantThreads.get(body.threadId);
    if (!thread) return;
    thread.toolCalls ??= [];
    if (!thread.toolCalls.some((entry) => entry.toolCallId === body.toolCallId)) {
      thread.toolCalls.push({
        toolCallId: body.toolCallId,
        ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
        toolName: body.toolName,
        ...(body.args !== undefined ? { args: structuredClone(body.args) } : {}),
      });
    }
  },
  assistantToolResult: (state, envelope) => {
    const body = readBody(envelope, 'assistantToolResult');
    const thread = state.assistantThreads.get(body.threadId);
    const entry = thread?.toolCalls?.find((tool) => tool.toolCallId === body.toolCallId);
    if (entry) {
      entry.summary = body.summary;
      entry.isError = body.isError;
    }
  },
};

/** A user message opens the turn (the reply's completion closes it). */
function userMessageFold(state: State, envelope: EventEnvelope): void {
  const body =
    envelope.name === 'assistantResent'
      ? readBody(envelope, 'assistantResent')
      : readBody(envelope, 'assistantUserMessage');
  const thread = state.assistantThreads.get(body.threadId);
  if (!thread) return;
  foldThreadMessage(thread, body.message);
  thread.status = 'running';
}

/**
 * Folds one thread message. Message indexes are the transcript's order —
 * the command path allocates them outside the write lock, so a queued
 * message can race a queued reply onto the same index. A message never
 * steals a slot the opposite role already holds: the latecomer lands past
 * every folded message instead (re-applying the event finds its own slot
 * free, so the fold stays idempotent).
 */
function foldThreadMessage(thread: AssistantThread, incoming: ChatMessage): void {
  thread.messages = upsertTranscriptMessage(thread.messages, incoming);
}
