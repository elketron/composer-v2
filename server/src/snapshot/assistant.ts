// The assistant threads' snapshot appender (Phase 6): the creation event
// carries the folded thread (scope, status, messages), then each message
// re-folds idempotently — the planning session's snapshot rule.

import type { AssistantThread } from '../wire/models.js';
import type { FrameEmitter } from './emit.js';

export function appendAssistantThreads(
  emit: FrameEmitter,
  threads: Map<string, AssistantThread>,
): void {
  const ordered = [...threads.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  for (const thread of ordered) {
    emit(undefined, 'assistantThreadCreated', { thread: structuredClone(thread) });
    for (const message of thread.messages) {
      const eventType = message.role === 'user' ? 'assistantUserMessage' : 'assistantMessageComplete';
      emit(undefined, eventType, { threadId: thread.id, message: structuredClone(message) });
    }
    // The message replays derive running/idle; a stopped or failed thread
    // re-marks itself so its terminal status survives the snapshot.
    if (thread.status === 'stopped' || thread.status === 'failed') {
      emit(undefined, 'assistantThreadStatusChanged', { threadId: thread.id, status: thread.status });
    }
  }
}