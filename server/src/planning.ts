// The planning orchestrator: turns `userMessageReceived` events into agent
// turns (v1 planner route, sans the spect machinery). One engine turn per
// user message; turns serialize per session — a message that arrives while
// a turn is in flight is already folded into state and picked up by the
// turn loop's next run. The agent's replies stream as `agentMessageDelta`
// (ephemeral) and land as `agentMessageComplete`; document edits and
// ticket emissions ride the MCP tools' validated commands, not this path.
//
// No durable runs (D5): the turn loop is in-process; a restart drops
// in-flight turns (the queued messages are already in the transcript) and
// the engine-session continuity map (the next turn starts a fresh runtime
// session; the document and transcript are durable, so context survives).

import type { Bus } from './bus.js';
import type { EventFrame } from './wire/envelope.js';
import { nowIso } from './wire/envelope.js';
import { ensureAgentFiles, PLANNER_AGENT_NAME } from './agents.js';
import type { AgentEngine, AgentTurnEvent, AgentTurnSpec } from './engine/types.js';

export interface PlanningOptions {
  /** The shipped agent the turn loads. */
  agentName?: string;
  /** Wall-clock cap per turn. */
  timeoutMs?: number;
  /** Composer's HTTP base (the MCP tools' callback target). */
  serverUrl?: string;
  /** Absolute path to composer's MCP server script. */
  mcpScriptPath?: string;
}

export class PlanningOrchestrator {
  private readonly bus: Bus;
  private readonly engine: AgentEngine;
  private readonly options: Required<Pick<PlanningOptions, 'agentName' | 'timeoutMs'>> & PlanningOptions;
  /** Session id → user-message count at the in-flight turn's start (v1 InFlight). */
  private readonly inFlight = new Map<string, number>();
  /** Session id → the runtime's own session id (continuity, process lifetime). */
  private readonly engineSessions = new Map<string, string>();
  private unsubscribe: (() => void) | null = null;

  constructor(bus: Bus, engine: AgentEngine, options: PlanningOptions = {}) {
    this.bus = bus;
    this.engine = engine;
    this.options = { agentName: options.agentName ?? 'composer-planner', timeoutMs: options.timeoutMs ?? 600_000, ...options };
  }

  start(): void {
    this.unsubscribe = this.bus.subscribe((frame) => this.onFrame(frame));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private onFrame(frame: EventFrame): void {
    if (frame.eventType !== 'userMessageReceived') return;
    const body = frame.body as { sessionId?: string; message?: { text?: string } };
    if (frame.projectId === undefined || body.sessionId === undefined) return;
    void this.onUserMessage(frame.projectId, body.sessionId, body.message?.text ?? '');
  }

  private async onUserMessage(projectId: string, sessionId: string, text: string): Promise<void> {
    const found = this.sessionOf(projectId, sessionId);
    if (!found || found.session.status !== 'drafting') return;
    const count = this.userMessageCount(found.session);
    if (this.inFlight.has(sessionId)) {
      // A turn is running; the message is folded and the turn loop serves
      // it with the follow-up run.
      return;
    }
    this.inFlight.set(sessionId, count);
    try {
      await this.turnLoop(projectId, sessionId, count, text);
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  /** Drives turns until no new user message is queued behind the last one. */
  private async turnLoop(
    projectId: string,
    sessionId: string,
    count: number,
    firstText: string,
  ): Promise<void> {
    let text = firstText;
    for (;;) {
      const found = this.sessionOf(projectId, sessionId);
      if (!found || found.session.status !== 'drafting') return;

      // The runtime loads the shipped agent from the project directory;
      // ship it if absent (user-editable, never overwritten).
      if (found.directory !== undefined) {
        try {
          ensureAgentFiles(found.directory);
        } catch (error) {
          console.error(`planner: could not ship agent files to ${found.directory}:`, error);
        }
      }

      const spec: AgentTurnSpec = {
        projectId,
        sessionId,
        ...(found.directory !== undefined ? { projectDirectory: found.directory } : {}),
        prompt: buildPrompt(found.session.planDocument, text),
        ...(this.engineSessions.get(sessionId) !== undefined
          ? { engineSessionId: this.engineSessions.get(sessionId) }
          : {}),
        serverUrl: this.options.serverUrl ?? '',
        mcpScriptPath: this.options.mcpScriptPath ?? '',
        agentName: this.options.agentName ?? PLANNER_AGENT_NAME,
        timeoutMs: this.options.timeoutMs,
      };
      const outcome = await this.engine.run(spec, (event) =>
        this.onEngineEvent(projectId, sessionId, event),
      );
      if (outcome.engineSessionId !== undefined) {
        this.engineSessions.set(sessionId, outcome.engineSessionId);
      }
      if (!outcome.ok) {
        // The desktop's send-lock clears on the next agent message; a
        // failed turn publishes the failure as one so the UI unblocks.
        await this.publishAgentMessage(
          projectId,
          sessionId,
          `The planner turn failed: ${outcome.error ?? 'unknown error'}`,
        );
        return;
      }

      const now = this.sessionOf(projectId, sessionId);
      const countNow = now === undefined ? count : this.userMessageCount(now.session);
      if (countNow === count) return;
      // Only a new HUMAN message is a queued turn; pick up its text.
      const queued = now?.session.messages.filter((message) => message.role === 'user') ?? [];
      text = queued[queued.length - 1]?.text ?? '';
      count = countNow;
    }
  }

  private onEngineEvent(projectId: string, sessionId: string, event: AgentTurnEvent): void {
    if (event.kind === 'messageDelta') {
      const found = this.sessionOf(projectId, sessionId);
      if (!found) return;
      void this.bus.publish(projectId, 'agentMessageDelta', {
        sessionId,
        messageIndex: nextMessageIndex(found.session),
        delta: event.delta,
      });
      return;
    }
    void this.publishAgentMessage(projectId, sessionId, event.text);
  }

  private async publishAgentMessage(
    projectId: string,
    sessionId: string,
    text: string,
  ): Promise<void> {
    const found = this.sessionOf(projectId, sessionId);
    if (!found) return;
    await this.bus.publish(projectId, 'agentMessageComplete', {
      sessionId,
      message: { index: nextMessageIndex(found.session), role: 'agent', text, at: nowIso() },
    });
  }

  private sessionOf(projectId: string, sessionId: string) {
    const session = this.bus.state.byProject.get(projectId)?.planningSessions.get(sessionId);
    if (!session) return undefined;
    const directory = this.bus.state.projects.get(projectId)?.directory;
    return {
      session: structuredClone(session),
      ...(directory !== undefined ? { directory } : {}),
    };
  }

  /** The number of user messages on the session's transcript (v1 human_count). */
  private userMessageCount(session: { messages: { role: string }[] }): number {
    return session.messages.filter((message) => message.role === 'user').length;
  }
}

function buildPrompt(document: string, text: string): string {
  const documentBlock = document === '' ? '(the document is empty)' : document;
  return `Current plan document:\n\n${documentBlock}\n\nThe user says:\n\n${text}`;
}

function nextMessageIndex(session: { messages: { index: number }[] }): number {
  return session.messages.reduce((max, message) => Math.max(max, message.index), 0) + 1;
}
