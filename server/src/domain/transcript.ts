// Transcript index allocation for streaming turns — the one mechanism both
// orchestrators share. A message's deltas and its completion must agree on
// one index (the desktop keys the live bubble on it), and successive
// messages of one turn must not collide even when the fold lags the
// (synchronous) emit stream.

/** One past the highest message index on a transcript (v1 `next_message_index`; starts at 1). */
export function nextMessageIndex(transcript: readonly { index: number }[]): number {
  return transcript.reduce((max, message) => Math.max(max, message.index), 0) + 1;
}

/** The number of user messages on a transcript (v1 human_count). */
export function userMessageCount(transcript: readonly { role: string }[]): number {
  return transcript.filter((message) => message.role === 'user').length;
}

/**
 * Index reservations for in-flight turns, keyed by conversation (session or
 * thread) then engine messageId. `lastReserved` keeps the allocation
 * monotonic per conversation.
 */
export class ReservedIndexes {
  private readonly byMessage = new Map<string, Map<string, number>>();
  private readonly lastReserved = new Map<string, number>();

  /** The message's transcript index, reserved once per engine messageId. */
  reserve(conversationId: string, messageId: string, transcript: readonly { index: number }[]): number {
    const byMessage = this.byMessage.get(conversationId) ?? new Map<string, number>();
    const existing = byMessage.get(messageId);
    if (existing !== undefined) return existing;
    const reserved = Math.max(nextMessageIndex(transcript), (this.lastReserved.get(conversationId) ?? 0) + 1);
    byMessage.set(messageId, reserved);
    this.byMessage.set(conversationId, byMessage);
    this.lastReserved.set(conversationId, reserved);
    return reserved;
  }

  /** Advances the watermark past a landed index so the next reservation doesn't reuse it. */
  advance(conversationId: string, index: number): void {
    if (index > (this.lastReserved.get(conversationId) ?? 0)) {
      this.lastReserved.set(conversationId, index);
    }
  }

  /** Clears one conversation's reservations (its turn ended). */
  release(conversationId: string): void {
    this.byMessage.delete(conversationId);
    this.lastReserved.delete(conversationId);
  }
}
