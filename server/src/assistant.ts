// The global assistant orchestrator (Phase 6): turns `assistantUserMessage`
// events into engine turns. The turn loop, in-flight counting, transcript
// index reservation, engine-session continuity, and failure-message
// recovery are the planning orchestrator's, retargeted at the global thread
// slice — no project directory, no write tools (`mcpTools: 'none'`); the
// scoped read tools join in their slice.
//
// No durable runs (D5): a restart drops in-flight turns; the queued
// messages are already in the transcript and `resumeStrandedThreads` tells
// the user. Engine-session continuity is in-process state (the thread's
// messages are durable, so context survives a restart's fresh runtime
// session).

import { randomUUID } from 'node:crypto';
import type { Bus } from './bus.js';
import type { EventFrame } from './wire/envelope.js';
import { nowIso } from './wire/envelope.js';
import { ASSISTANT_AGENT_NAME, ensureAssistantWorkspace } from './agents/index.js';
import { resolveModel, type ComposerSettings } from './store/settings.js';
import type { AgentEngine, AgentTurnEvent, AgentTurnSpec } from './engine/types.js';
import type { AssistantThread } from './wire/models.js';
import { nextMessageIndex, ReservedIndexes, userMessageCount } from './domain/transcript.js';

/** The per-agent model for a turn's spec (override, else the default). */
function modelFor(settings: ComposerSettings): string | undefined {
  return resolveModel(settings, 'assistant');
}

export interface AssistantOptions {
  /** The shipped agent the turn loads. */
  agentName?: string;
  /** Wall-clock cap per turn. */
  timeoutMs?: number;
  /** Composer's HTTP base (the MCP tools' callback target). */
  serverUrl?: string;
  /** Absolute path to composer's assistant MCP server script (dist/assistant-mcp.js). */
  mcpScriptPath?: string;
  /** Composer's assistant workspace (the agent definition's home; the runtime's cwd). */
  workspaceDir?: string;
  /** The settings provider — the model override rides each turn's spec. */
  getModel?: () => Promise<ComposerSettings> | ComposerSettings;
}

export class AssistantOrchestrator {
  private readonly bus: Bus;
  private readonly engine: AgentEngine;
  private readonly options: Required<Pick<AssistantOptions, 'agentName' | 'timeoutMs'>> &
    AssistantOptions;
  /** Thread id → user-message count at the in-flight turn's start. */
  private readonly inFlight = new Map<string, number>();
  /**
   * Transcript index reservations, keyed by thread then engine messageId —
   * a message's deltas and its completion must agree on one index, and
   * successive messages of one turn must not collide (the planning rule).
   */
  private readonly indexes = new ReservedIndexes();
  /** Thread id → the runtime's own session id (continuity, process lifetime). */
  private readonly engineSessions = new Map<string, string>();
  /** Thread id → the in-flight turn's abort controller (the stop kill switch). */
  private readonly controllers = new Map<string, AbortController>();
  /** Thread id → the part currently streaming (its partial text, for stop). */
  private readonly streaming = new Map<string, { messageId: string; text: string }>();
  /**
   * Thread id → the turn's last completed message part. Intermediate parts
   * stream live but never land durably — one reply per turn, the final one
   * (the tool strip carries the in-between story). Flushed at run end.
   */
  private readonly lastCompletion = new Map<string, { messageId: string; text: string }>();
  /** Thread id → the user message id the in-flight turn answers (reply lineage). */
  private readonly turnParents = new Map<string, string>();
  private unsubscribe: (() => void) | null = null;

  constructor(bus: Bus, engine: AgentEngine, options: AssistantOptions = {}) {
    this.bus = bus;
    this.engine = engine;
    this.options = {
      agentName: options.agentName ?? ASSISTANT_AGENT_NAME,
      timeoutMs: options.timeoutMs ?? 600_000,
      ...options,
    };
  }

  start(): void {
    this.unsubscribe = this.bus.subscribe((frame) => {
      void this.onFrame(frame).catch((error) => console.error('assistant:', error));
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private onFrame(frame: EventFrame): Promise<void> {
    if (frame.projectId !== undefined) return Promise.resolve();
    const body = frame.body as { threadId?: string };
    const threadId = body?.threadId;
    if (threadId === undefined) return Promise.resolve();
    if (frame.eventType === 'assistantUserMessage' || frame.eventType === 'assistantResent') {
      const message = (frame.body as { message?: { text?: string } }).message;
      return this.onUserMessage(threadId, message?.text ?? '');
    }
    if (frame.eventType === 'assistantRetryRequested') {
      return this.onRetry(threadId);
    }
    if (frame.eventType === 'assistantThreadStopped') {
      // The processor already marked the thread `stopped`; aborting the
      // engine resolves the run and the partial reply lands as content.
      this.controllers.get(threadId)?.abort();
      return Promise.resolve();
    }
    return Promise.resolve();
  }

  private async onUserMessage(threadId: string, text: string): Promise<void> {
    const thread = this.threadOf(threadId);
    if (!thread || thread.archivedAt !== undefined) return;
    const count = userMessageCount(thread.messages);
    if (this.inFlight.has(threadId)) {
      // A turn is running; the message is folded and the turn loop serves
      // it with the follow-up run.
      return;
    }
    this.inFlight.set(threadId, count);
    try {
      await this.turnLoop(threadId, count, text);
    } finally {
      this.inFlight.delete(threadId);
      this.indexes.release(threadId);
      this.lastCompletion.delete(threadId);
      this.streaming.delete(threadId);
    }
  }

  /** A retry re-runs the thread's last user message (the reply appends). */
  private async onRetry(threadId: string): Promise<void> {
    const thread = this.threadOf(threadId);
    if (!thread || thread.archivedAt !== undefined) return;
    if (this.inFlight.has(threadId)) return;
    const lastUser = [...thread.messages].reverse().find((message) => message.role === 'user');
    if (lastUser === undefined) return;
    const count = userMessageCount(thread.messages);
    this.inFlight.set(threadId, count);
    try {
      await this.turnLoop(threadId, count, lastUser.text);
    } finally {
      this.inFlight.delete(threadId);
      this.indexes.release(threadId);
      this.lastCompletion.delete(threadId);
      this.streaming.delete(threadId);
    }
  }

  /** Drives turns until no new user message is queued behind the last one. */
  private async turnLoop(threadId: string, count: number, firstText: string): Promise<void> {
    let text = firstText;
    for (;;) {
      const thread = this.threadOf(threadId);
      if (!thread || thread.archivedAt !== undefined) return;

      // The runtime loads the shipped agent from composer's assistant
      // workspace; ship it if absent (user-editable, never overwritten).
      if (this.options.workspaceDir !== undefined) {
        try {
          ensureAssistantWorkspace(this.options.workspaceDir);
        } catch (error) {
          console.error(`assistant: could not ship the agent definition:`, error);
        }
      }

      const settings = (await this.options.getModel?.()) ?? {};
      const spec: AgentTurnSpec = {
        sessionId: threadId,
        ...(this.options.workspaceDir !== undefined
          ? { projectDirectory: this.options.workspaceDir }
          : {}),
        prompt: buildAssistantPrompt(thread, text),
        ...(this.engineSessions.get(threadId) !== undefined
          ? { engineSessionId: this.engineSessions.get(threadId) }
          : {}),
        serverUrl: this.options.serverUrl ?? '',
        mcpScriptPath: this.options.mcpScriptPath ?? '',
        agentName: this.options.agentName ?? ASSISTANT_AGENT_NAME,
        ...(modelFor(settings) ? { model: modelFor(settings) } : {}),
        timeoutMs: this.options.timeoutMs,
        mcpTools: 'assistant',
      };
      const controller = new AbortController();
      this.controllers.set(threadId, controller);
      // The turn answers the thread's newest user message — that is the
      // reply's parent (a resent edit is the newest user message, so the
      // reply opens the new branch).
      const parent = [...thread.messages].reverse().find((message) => message.role === 'user');
      if (parent?.id !== undefined) this.turnParents.set(threadId, parent.id);
      const outcome = await this.engine.run(
        { ...spec, signal: controller.signal },
        (event) => this.onEngineEvent(threadId, event),
      );
      this.controllers.delete(threadId);
      if (outcome.engineSessionId !== undefined) {
        this.engineSessions.set(threadId, outcome.engineSessionId);
      }
      if (!outcome.ok) {
        if (controller.signal.aborted) {
          // A user stop: the latest content lands as the turn's one reply —
          // the part that was streaming, else the last completed part — and
          // the thread keeps its canonical `stopped` status.
          const stream = this.streaming.get(threadId);
          const last = this.lastCompletion.get(threadId);
          const messageId = stream?.messageId ?? last?.messageId ?? `stopped:${threadId}`;
          const text = stream?.text !== undefined && stream.text !== '' ? stream.text : (last?.text ?? 'stopped.');
          await this.publishAssistantMessage(threadId, messageId, text);
          return;
        }
        // The desktop's send-lock clears on the next assistant message; a
        // failed turn publishes the failure as one so the UI unblocks.
        await this.publishAssistantMessage(
          threadId,
          `failure:${threadId}`,
          `The assistant turn failed: ${outcome.error ?? 'unknown error'}`,
        );
        await this.bus.publish(undefined, 'assistantThreadStatusChanged', {
          threadId,
          status: 'failed',
        });
        return;
      }

      // One durable reply per turn: only the final message lands.
      const last = this.lastCompletion.get(threadId);
      this.lastCompletion.delete(threadId);
      if (last !== undefined) {
        await this.publishAssistantMessage(threadId, last.messageId, last.text);
      }

      const now = this.threadOf(threadId);
      const countNow = now === undefined ? count : userMessageCount(now.messages);
      if (countNow === count) return;
      // Only a new HUMAN message is a queued turn; pick up its text.
      const queued = now?.messages.filter((message) => message.role === 'user') ?? [];
      text = queued.at(-1)?.text ?? '';
      count = countNow;
    }
  }

  private onEngineEvent(threadId: string, event: AgentTurnEvent): void {
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
      // The part's authoritative text buffers for the flush at run end;
      // nothing durable lands mid-turn (one reply per turn).
      this.lastCompletion.set(threadId, { messageId: event.messageId, text: event.text });
      const stream = this.streaming.get(threadId);
      if (stream?.messageId === event.messageId) this.streaming.delete(threadId);
      return;
    }
    return;
  }

  private async publishAssistantMessage(
    threadId: string,
    engineMessageId: string,
    text: string,
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
        index,
        role: 'agent',
        text,
        at: nowIso(),
      },
    });
  }

  private threadOf(threadId: string): AssistantThread | undefined {
    return this.bus.state.assistantThreads.get(threadId);
  }

}

function buildAssistantPrompt(thread: AssistantThread, text: string): string {
  const scope =
    thread.projectIds.length > 0 ? thread.projectIds.join(', ') : '(no projects selected)';
  const recent = thread.messages
    .slice(-10)
    .map((message) => `${message.role === 'user' ? 'user' : 'assistant'}: ${message.text}`)
    .join('\n');
  return [
    `You are the user's cross-project assistant. Selected projects: ${scope}.`,
    recent !== '' ? `\nRecent transcript:\n\n${recent}\n` : '',
    `\nThe user says:\n\n${text}`,
  ].join('');
}

/**
 * The tool output's head, for the working box's settled row. Full outputs
 * stay reachable through the tools themselves; the log keeps the digest.
 */
const TOOL_SUMMARY_CAP = 2_000;

function capToolSummary(content: string): string {
  return content.length <= TOOL_SUMMARY_CAP ? content : `${content.slice(0, TOOL_SUMMARY_CAP)}…`;
}

/**
 * A restart drops in-flight turns — a thread whose transcript ends with a
 * user message lost its turn (no assistant reply will ever come for it).
 * Publish one failure message per stranded thread so the transcript is
 * coherent and the desktop's send-lock clears. The next real turn's prompt
 * carries the whole transcript, so nothing is lost.
 */
export async function resumeStrandedThreads(bus: Bus): Promise<number> {
  let resumed = 0;
  for (const thread of bus.state.assistantThreads.values()) {
    if (thread.archivedAt !== undefined) continue;
    const last = thread.messages.at(-1);
    if (last === undefined || last.role !== 'user') continue;
    await bus.publish(undefined, 'assistantMessageComplete', {
      threadId: thread.id,
      message: {
        id: randomUUID(),
        ...(last.id !== undefined ? { parentId: last.id } : {}),
        index: nextMessageIndex(thread.messages),
        role: 'agent',
        text: 'the server restarted before this turn could run — send your message again',
        at: nowIso(),
      },
    });
    resumed++;
  }
  return resumed;
}
