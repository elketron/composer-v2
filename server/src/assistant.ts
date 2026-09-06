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

import type { Bus } from './bus.js';
import type { EventFrame } from './wire/envelope.js';
import { nowIso } from './wire/envelope.js';
import { ASSISTANT_AGENT_NAME, ensureAssistantWorkspace } from './agents.js';
import { resolveModel, type ComposerSettings } from './store.js';
import type { AgentEngine, AgentTurnEvent, AgentTurnSpec } from './engine/types.js';
import type { AssistantThread } from './wire/models.js';

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
  private readonly reservedIndex = new Map<string, Map<string, number>>();
  private readonly lastReserved = new Map<string, number>();
  /** Thread id → the runtime's own session id (continuity, process lifetime). */
  private readonly engineSessions = new Map<string, string>();
  /** Thread id → the in-flight turn's abort controller (the stop kill switch). */
  private readonly controllers = new Map<string, AbortController>();
  /** Thread id → the streaming message being accumulated (for stop's partial text). */
  private readonly streaming = new Map<string, { messageId: string; text: string }>();
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
    if (frame.eventType === 'assistantUserMessage') {
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
    const count = this.userMessageCount(thread);
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
      this.reservedIndex.delete(threadId);
      this.lastReserved.delete(threadId);
    }
  }

  /** A retry re-runs the thread's last user message (the reply appends). */
  private async onRetry(threadId: string): Promise<void> {
    const thread = this.threadOf(threadId);
    if (!thread || thread.archivedAt !== undefined) return;
    if (this.inFlight.has(threadId)) return;
    const lastUser = [...thread.messages].reverse().find((message) => message.role === 'user');
    if (lastUser === undefined) return;
    const count = this.userMessageCount(thread);
    this.inFlight.set(threadId, count);
    try {
      await this.turnLoop(threadId, count, lastUser.text);
    } finally {
      this.inFlight.delete(threadId);
      this.reservedIndex.delete(threadId);
      this.lastReserved.delete(threadId);
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
          // A user stop: the partial reply (if any) lands as the turn's
          // content; the thread keeps its canonical `stopped` status.
          const stream = this.streaming.get(threadId);
          const text = stream?.text !== undefined && stream.text !== '' ? stream.text : 'stopped.';
          await this.publishAssistantMessage(threadId, stream?.messageId ?? `stopped:${threadId}`, text);
          this.streaming.delete(threadId);
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

      const now = this.threadOf(threadId);
      const countNow = now === undefined ? count : this.userMessageCount(now);
      if (countNow === count) return;
      // Only a new HUMAN message is a queued turn; pick up its text.
      const queued = now?.messages.filter((message) => message.role === 'user') ?? [];
      text = queued.at(-1)?.text ?? '';
      count = countNow;
    }
  }

  private onEngineEvent(threadId: string, event: AgentTurnEvent): void {
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
        messageIndex: this.reserveIndex(threadId, event.messageId, thread),
        delta: event.delta,
      });
      return;
    }
    if (event.kind === 'messageComplete') {
      // A completed part clears the stream buffer (its text landed durably).
      const stream = this.streaming.get(threadId);
      if (stream?.messageId === event.messageId) this.streaming.delete(threadId);
    }
    if (event.kind !== 'messageComplete') return;
    void this.publishAssistantMessage(threadId, event.messageId, event.text);
  }

  private async publishAssistantMessage(
    threadId: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    const thread = this.threadOf(threadId);
    if (!thread) return;
    // The completion lands past every folded message: a user message that
    // folded onto the delta's reserved index must not be stolen by the
    // reply (the transcript sorts by index). The watermark advances so the
    // next reservation doesn't reuse the bumped index.
    const reserved = this.reserveIndex(threadId, messageId, thread);
    const index = Math.max(reserved, nextMessageIndex(thread));
    if (index > (this.lastReserved.get(threadId) ?? 0)) {
      this.lastReserved.set(threadId, index);
    }
    await this.bus.publish(undefined, 'assistantMessageComplete', {
      threadId,
      message: { index, role: 'agent', text, at: nowIso() },
    });
  }

  /** The message's transcript index (reserved once per engine messageId). */
  private reserveIndex(
    threadId: string,
    messageId: string,
    thread: { messages: { index: number }[] },
  ): number {
    const byMessage = this.reservedIndex.get(threadId) ?? new Map<string, number>();
    const existing = byMessage.get(messageId);
    if (existing !== undefined) return existing;
    const reserved = Math.max(
      nextMessageIndex(thread),
      (this.lastReserved.get(threadId) ?? 0) + 1,
    );
    byMessage.set(messageId, reserved);
    this.reservedIndex.set(threadId, byMessage);
    this.lastReserved.set(threadId, reserved);
    return reserved;
  }

  private threadOf(threadId: string): AssistantThread | undefined {
    return this.bus.state.assistantThreads.get(threadId);
  }

  /** The number of user messages on the thread's transcript. */
  private userMessageCount(thread: { messages: { role: string }[] }): number {
    return thread.messages.filter((message) => message.role === 'user').length;
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

function nextMessageIndex(thread: { messages: { index: number }[] }): number {
  return thread.messages.reduce((max, message) => Math.max(max, message.index), 0) + 1;
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
        index: nextMessageIndex(thread),
        role: 'agent',
        text: 'the server restarted before this turn could run — send your message again',
        at: nowIso(),
      },
    });
    resumed++;
  }
  return resumed;
}
