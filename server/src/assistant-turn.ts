// The assistant turn's per-thread projection (SRV-005): the mutable state a
// turn leaves around — the abort controller, the part currently streaming,
// the last completed part, and the reply lineage — plus the projection of
// engine events onto the thread's wire (tool activity, deltas, durable
// intermediate activity, the final reply, and failure/stop handling). The
// assistant orchestrator owns only routing and the shared `TurnCoordinator`;
// this class owns the assistant-specific turn state.

import { randomUUID } from 'node:crypto';
import type { Bus } from './bus.js';
import { nowIso } from './wire/envelope.js';
import type { AgentTurnEvent, AgentTurnOutcome } from './engine/types.js';
import type { AssistantThread } from './wire/models.js';
import { nextMessageIndex, type ReservedIndexes } from './domain/transcript.js';

export class AssistantTurnProjector {
  /** Thread id → the in-flight turn's abort controller (the stop kill switch). */
  private readonly controllers = new Map<string, AbortController>();
  /** Thread id → the part currently streaming (its partial text, for stop). */
  private readonly streaming = new Map<string, { messageId: string; text: string }>();
  /**
   * Thread id → the turn's last completed message part. Earlier parts become
   * durable activity when another part starts; this final candidate flushes
   * as the normal reply at run end.
   */
  private readonly lastCompletion = new Map<string, { messageId: string; text: string }>();
  /** Intermediate completion writes must land before the final reply. */
  private readonly activityWrites = new Map<string, Promise<void>>();
  /** Thread id → the user message id the in-flight turn answers (reply lineage). */
  private readonly turnParents = new Map<string, string>();

  constructor(
    private readonly bus: Bus,
    private readonly indexes: ReservedIndexes,
    private readonly threadOf: (threadId: string) => AssistantThread | undefined,
  ) {}

  /** Opens a turn: a fresh controller and the reply's parent (the newest user message). */
  begin(threadId: string): void {
    this.controllers.set(threadId, new AbortController());
    const thread = this.threadOf(threadId);
    const parent = thread?.messages !== undefined
      ? [...thread.messages].reverse().find((message) => message.role === 'user')
      : undefined;
    if (parent?.id !== undefined) this.turnParents.set(threadId, parent.id);
  }

  /** The turn's abort controller (buildSpec rides its signal). */
  controller(threadId: string): AbortController {
    return this.controllers.get(threadId) ?? new AbortController();
  }

  /** The stop kill switch. */
  abort(threadId: string): void {
    this.controllers.get(threadId)?.abort();
  }

  /** Projects one streamed engine event onto the thread's wire. */
  onEvent(threadId: string, event: AgentTurnEvent): void {
    if (event.kind === 'toolCall') {
      // The working box (S25): the turn's tool activity rides the thread
      // under the user message the turn answers.
      const parent = this.turnParents.get(threadId);
      void this.bus.publish(undefined, 'assistantToolCall', {
        threadId,
        ...(parent !== undefined ? { parentId: parent } : {}),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ...(event.args !== undefined ? { args: event.args } : {}),
      });
      return;
    }
    if (event.kind === 'toolResult') {
      void this.bus.publish(undefined, 'assistantToolResult', {
        threadId,
        toolCallId: event.toolCallId,
        summary: capToolSummary(event.content),
        isError: event.isError,
      });
      return;
    }
    if (event.kind === 'messageDelta') {
      const thread = this.threadOf(threadId);
      if (!thread) return;
      const stream = this.streaming.get(threadId);
      const completed = this.lastCompletion.get(threadId);
      if (completed !== undefined && completed.messageId !== event.messageId) {
        this.promoteCompletion(threadId, completed);
      }
      if (stream === undefined || stream.messageId !== event.messageId) {
        this.streaming.set(threadId, { messageId: event.messageId, text: event.delta });
      } else {
        stream.text += event.delta;
      }
      void this.bus.publish(undefined, 'assistantMessageDelta', {
        threadId,
        messageIndex: this.indexes.reserve(threadId, event.messageId, thread.messages),
        delta: event.delta,
      });
      return;
    }
    if (event.kind === 'messageComplete') {
      const previous = this.lastCompletion.get(threadId);
      if (previous !== undefined && previous.messageId !== event.messageId) {
        this.promoteCompletion(threadId, previous);
      }
      this.lastCompletion.set(threadId, { messageId: event.messageId, text: event.text });
      const stream = this.streaming.get(threadId);
      if (stream?.messageId === event.messageId) this.streaming.delete(threadId);
      return;
    }
    return;
  }

  /** A successful turn: flush the one durable reply. */
  async flush(threadId: string): Promise<void> {
    const last = this.lastCompletion.get(threadId);
    this.lastCompletion.delete(threadId);
    await this.activityWrites.get(threadId);
    if (last !== undefined) {
      await this.publish(threadId, last.messageId, last.text);
    }
  }

  /** A failed turn: a user stop lands the partial, else a failure + `failed` status. */
  async fail(threadId: string, outcome: AgentTurnOutcome): Promise<void> {
    await this.activityWrites.get(threadId);
    if (this.controllers.get(threadId)?.signal.aborted) {
      // A user stop: the latest content lands as the turn's one reply — the
      // part that was streaming, else the last completed part — and the
      // thread keeps its canonical `stopped` status.
      const stream = this.streaming.get(threadId);
      const last = this.lastCompletion.get(threadId);
      const messageId = stream?.messageId ?? last?.messageId ?? `stopped:${threadId}`;
      const text = stream?.text !== undefined && stream.text !== '' ? stream.text : (last?.text ?? 'stopped.');
      await this.publish(threadId, messageId, text);
      return;
    }
    // The desktop's send-lock clears on the next assistant message; a
    // failed turn publishes the failure as one so the UI unblocks.
    await this.publish(threadId, `failure:${threadId}`, `The assistant turn failed: ${outcome.error ?? 'unknown error'}`);
    await this.bus.publish(undefined, 'assistantThreadStatusChanged', {
      threadId,
      status: 'failed',
    });
  }

  /** Drops a turn's leftover state (the coordinator's cleanup hook). */
  cleanup(threadId: string): void {
    this.controllers.delete(threadId);
    this.lastCompletion.delete(threadId);
    this.streaming.delete(threadId);
    this.activityWrites.delete(threadId);
  }

  private promoteCompletion(
    threadId: string,
    completion: { messageId: string; text: string },
  ): void {
    this.lastCompletion.delete(threadId);
    const previous = this.activityWrites.get(threadId) ?? Promise.resolve();
    this.activityWrites.set(
      threadId,
      previous.then(() => this.publish(threadId, completion.messageId, completion.text, true)),
    );
  }

  private async publish(
    threadId: string,
    engineMessageId: string,
    text: string,
    activity = false,
  ): Promise<void> {
    const thread = this.threadOf(threadId);
    if (!thread) return;
    // The completion lands past every folded message: a user message that
    // folded onto the delta's reserved index must not be stolen by the
    // reply (the transcript sorts by index). The watermark advances so the
    // next reservation doesn't reuse the bumped index.
    const reserved = this.indexes.reserve(threadId, engineMessageId, thread.messages);
    const index = Math.max(reserved, nextMessageIndex(thread.messages));
    this.indexes.advance(threadId, index);
    const parentId = this.turnParents.get(threadId);
    await this.bus.publish(undefined, 'assistantMessageComplete', {
      threadId,
      message: {
        id: randomUUID(),
        ...(parentId !== undefined ? { parentId } : {}),
        ...(activity ? { activity: true } : {}),
        index,
        role: 'agent',
        text,
        at: nowIso(),
      },
    });
  }
}

/**
 * The tool output's head, for the working box's settled row. Full outputs
 * stay reachable through the tools themselves; the log keeps the digest.
 */
const TOOL_SUMMARY_CAP = 2_000;

function capToolSummary(content: string): string {
  return content.length <= TOOL_SUMMARY_CAP ? content : `${content.slice(0, TOOL_SUMMARY_CAP)}…`;
}
