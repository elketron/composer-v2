// The shared text/tool reduction (SRV-016): both the run and serve adapters
// translate their own wire events into `AgentTurnEvent`s, and both reduce a
// part's growing text into byte-precise deltas and a tool call into an
// announce-then-settle pair. This module is the one reducer both lean on;
// each adapter only maps its vendor shape onto these primitives.

import type { AgentTurnEvent } from './types.js';

/** A tool's output as text: string, the recorded error, or a JSON dump. */
export function resultContent(output: unknown, error?: string): string {
  if (typeof output === 'string') return output;
  if (output === undefined) return error ?? '';
  return JSON.stringify(output);
}

/** One text part's streamed emission (growing text → byte-precise deltas). */
export class TextReducer {
  private text = '';
  private emitted = 0;
  private completed = false;

  /**
   * A full-text snapshot (the CLI's repeated `text` parts, the serve's
   * `part.updated`). Returns the un-emitted suffix, or null when nothing
   * new arrived.
   */
  sync(full: string): string | null {
    const delta = full.length > this.emitted ? full.slice(this.emitted) : null;
    this.text = full;
    this.emitted = Math.max(this.emitted, full.length);
    return delta;
  }

  /** An incremental token chunk (the serve's `part.delta`). */
  append(delta: string): string {
    this.text += delta;
    this.emitted = this.text.length;
    return delta;
  }

  fullText(): string {
    return this.text;
  }

  hasText(): boolean {
    return this.text !== '';
  }

  isCompleted(): boolean {
    return this.completed;
  }

  markComplete(): void {
    this.completed = true;
  }
}

/** One tool part's announce-then-settle reduction. */
export class ToolReducer {
  private announced = false;
  private settled = false;

  /**
   * Feeds one tool-part sighting. Settling happens once, on a terminal
   * status (`completed`/`error`) — or, with `settleOnOutput`, on the first
   * sighting that already carries output (the CLI's `tool_use`, where
   * output presence is the terminal signal and a first sighting never
   * re-checks against a later status).
   */
  step(
    call: {
      toolCallId: string;
      toolName: string;
      status?: string;
      input?: unknown;
      output?: unknown;
      error?: string;
    },
    settleOnOutput: boolean,
  ): AgentTurnEvent[] {
    const events: AgentTurnEvent[] = [];
    if (!this.announced) {
      this.announced = true;
      events.push({
        kind: 'toolCall',
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        ...(call.input !== undefined ? { args: call.input } : {}),
      });
      if (settleOnOutput) {
        if (call.output !== undefined) {
          this.settled = true;
          events.push({
            kind: 'toolResult',
            toolCallId: call.toolCallId,
            content: resultContent(call.output, call.error),
            isError: call.status === 'error',
          });
        }
        return events;
      }
    }
    if (!this.settled && (call.status === 'completed' || call.status === 'error')) {
      this.settled = true;
      events.push({
        kind: 'toolResult',
        toolCallId: call.toolCallId,
        content: resultContent(call.output, call.error),
        isError: call.status === 'error',
      });
    }
    return events;
  }
}