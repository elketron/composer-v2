// The global assistant orchestrator (Phase 6): turns `assistantUserMessage`
// events into engine turns. The turn loop, in-flight counting, transcript
// index reservation, engine-session continuity, and failure-message
// recovery are the shared `TurnCoordinator`'s; the per-turn state and the
// event projection live in `AssistantTurnProjector`. The orchestrator's own
// remaining work is routing frames and building the turn spec.
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
import type { AgentEngine, AgentTurnSpec } from './engine/types.js';
import type { AssistantThread } from './wire/models.js';
import { nextMessageIndex, userMessageCount } from './domain/transcript.js';
import { TurnCoordinator, nextQueuedMessage } from './turn.js';
import { AssistantTurnProjector } from './assistant-turn.js';

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
  /** Ships the assistant's agent definition (defaults to `ensureAssistantWorkspace`). */
  provision?: (directory: string) => void;
}

/** The per-agent model for a turn's spec (override, else the default). */
function modelFor(settings: ComposerSettings): string | undefined {
  return resolveModel(settings, 'assistant');
}

/** The scope and transcript the assistant turn's prompt carries. */
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

export class AssistantOrchestrator {
  private readonly bus: Bus;
  private readonly engine: AgentEngine;
  private readonly options: Required<Pick<AssistantOptions, 'agentName' | 'timeoutMs'>> &
    AssistantOptions;
  private readonly coordinator: TurnCoordinator;
  private readonly projector: AssistantTurnProjector;

  constructor(bus: Bus, engine: AgentEngine, options: AssistantOptions = {}) {
    this.bus = bus;
    this.engine = engine;
    this.options = {
      agentName: options.agentName ?? ASSISTANT_AGENT_NAME,
      timeoutMs: options.timeoutMs ?? 600_000,
      ...options,
    };
    this.coordinator = new TurnCoordinator(bus, engine, {
      label: 'assistant',
      active: (threadId) => {
        const thread = this.threadOf(threadId);
        return thread !== undefined && thread.archivedAt === undefined;
      },
      provision: () => {
        if (this.options.workspaceDir === undefined) return;
        try {
          (this.options.provision ?? ensureAssistantWorkspace)(this.options.workspaceDir);
        } catch (error) {
          console.error('assistant: could not ship the agent definition:', error);
        }
      },
      beforeRun: (threadId) => this.projector.begin(threadId),
      buildSpec: async (threadId, text, engineSessionId) => {
        const thread = this.threadOf(threadId)!;
        const settings = (await this.options.getModel?.()) ?? {};
        return {
          sessionId: threadId,
          ...(this.options.workspaceDir !== undefined
            ? { projectDirectory: this.options.workspaceDir }
            : {}),
          prompt: buildAssistantPrompt(thread, text),
          ...(engineSessionId !== undefined ? { engineSessionId } : {}),
          serverUrl: this.options.serverUrl ?? '',
          mcpScriptPath: this.options.mcpScriptPath ?? '',
          agentName: this.options.agentName ?? ASSISTANT_AGENT_NAME,
          ...(modelFor(settings) ? { model: modelFor(settings) } : {}),
          timeoutMs: this.options.timeoutMs,
          mcpTools: 'assistant',
          signal: this.projector.controller(threadId).signal,
        };
      },
      onEvent: (threadId, event) => this.projector.onEvent(threadId, event),
      onFailure: (threadId, outcome) => this.projector.fail(threadId, outcome),
      onSuccess: (threadId) => this.projector.flush(threadId),
      nextQueued: (threadId, count) => nextQueuedMessage(() => this.threadOf(threadId), count),
      userCount: (threadId) => {
        const thread = this.threadOf(threadId);
        return thread === undefined ? 0 : userMessageCount(thread.messages);
      },
      cleanup: (threadId) => this.projector.cleanup(threadId),
    });
    this.projector = new AssistantTurnProjector(bus, this.coordinator.indexes, (threadId) =>
      this.threadOf(threadId),
    );
  }

  start(): void {
    this.coordinator.start((frame) => this.onFrame(frame));
  }

  stop(): void {
    this.coordinator.stop();
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
      this.projector.abort(threadId);
      return Promise.resolve();
    }
    return Promise.resolve();
  }

  private async onUserMessage(threadId: string, text: string): Promise<void> {
    await this.coordinator.runTurn(threadId, text);
  }

  /** A retry re-runs the thread's last user message (the reply appends). */
  private async onRetry(threadId: string): Promise<void> {
    if (this.coordinator.isRunning(threadId)) return;
    const thread = this.threadOf(threadId);
    if (!thread || thread.archivedAt !== undefined) return;
    const lastUser = [...thread.messages].reverse().find((message) => message.role === 'user');
    if (lastUser === undefined) return;
    await this.coordinator.runTurn(threadId, lastUser.text);
  }

  private threadOf(threadId: string): AssistantThread | undefined {
    return this.bus.state.assistantThreads.get(threadId);
  }
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