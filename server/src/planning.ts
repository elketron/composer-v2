// The planning orchestrator: turns `userMessageReceived` events into agent
// turns (v1 planner route, sans the spect machinery). One engine turn per
// user message; turns serialize per session — a message that arrives while
// a turn is in flight is already folded into state and picked up by the
// turn loop's next run. The agent's replies stream as `agentMessageDelta`
// (ephemeral) and land as `agentMessageComplete`; document edits and
// ticket emissions ride the MCP tools' validated commands, not this path.
//
// The shared turn lifecycle (subscription, in-flight lock, engine-session
// continuity, transcript index reservations, the follower loop) lives in
// the `TurnCoordinator`; this class supplies the planner-specific hooks.
//
// No durable runs (D5): the turn loop is in-process; a restart drops
// in-flight turns (the queued messages are already in the transcript) and
// the engine-session continuity map (the next turn starts a fresh runtime
// session; the document and transcript are durable, so context survives).

import type { Bus } from './bus.js';
import type { EventFrame } from './wire/envelope.js';
import { nowIso } from './wire/envelope.js';
import { ensureAgentFiles, PLANNER_AGENT_NAME } from './agents/index.js';
import { resolveModel, type ComposerSettings } from './store/settings.js';
import type { AgentEngine, AgentTurnEvent, AgentTurnSpec } from './engine/types.js';
import { nextMessageIndex, userMessageCount } from './domain/transcript.js';
import { TurnCoordinator, nextQueuedMessage } from './turn.js';

/** The per-agent model for a turn's spec (override, else the default). */
function modelFor(settings: ComposerSettings, agentName: string): string | undefined {
  // Settings keys are bare agent kinds; the shipped agents are composer-*.
  const kind = agentName.replace(/^composer-/, '');
  return resolveModel(settings, kind);
}

export interface PlanningOptions {
  /** The shipped agent the turn loads. */
  agentName?: string;
  /** Wall-clock cap per turn. */
  timeoutMs?: number;
  /** Composer's HTTP base (the MCP tools' callback target). */
  serverUrl?: string;
  /** Absolute path to composer's MCP server script. */
  mcpScriptPath?: string;
  /** The settings provider — the model override rides each turn's spec. */
  getModel?: () => Promise<{ model?: string }> | { model?: string };
}

/** The turn id: a session is keyed by (project, session) — ids repeat per project. */
function turnKey(projectId: string, sessionId: string): string {
  return `${projectId}/${sessionId}`;
}

function splitTurnKey(key: string): { projectId: string; sessionId: string } {
  const at = key.indexOf('/');
  return { projectId: key.slice(0, at), sessionId: key.slice(at + 1) };
}

export class PlanningOrchestrator {
  private readonly bus: Bus;
  private readonly engine: AgentEngine;
  private readonly options: Required<Pick<PlanningOptions, 'agentName' | 'timeoutMs'>> & PlanningOptions;
  private readonly coordinator: TurnCoordinator;

  constructor(bus: Bus, engine: AgentEngine, options: PlanningOptions = {}) {
    this.bus = bus;
    this.engine = engine;
    this.options = {
      agentName: options.agentName ?? 'composer-planner',
      timeoutMs: options.timeoutMs ?? 600_000,
      ...options,
    };
    this.coordinator = new TurnCoordinator(bus, engine, {
      label: 'planner',
      active: (key) => {
        const { projectId, sessionId } = splitTurnKey(key);
        const found = this.sessionOf(projectId, sessionId);
        return found !== undefined && found.session.status === 'drafting';
      },
      provision: (key) => {
        const { projectId, sessionId } = splitTurnKey(key);
        const directory = this.bus.state.projects.get(projectId)?.directory;
        if (directory === undefined) return;
        try {
          ensureAgentFiles(directory);
        } catch (error) {
          console.error(`planner: could not ship agent files to ${directory}:`, error);
        }
      },
      buildSpec: async (key, text, engineSessionId) => {
        const { projectId, sessionId } = splitTurnKey(key);
        const found = this.sessionOf(projectId, sessionId)!;
        const settings = (await this.options.getModel?.()) ?? {};
        return {
          projectId,
          sessionId,
          ...(found.directory !== undefined ? { projectDirectory: found.directory } : {}),
          prompt: buildPrompt(found.session.planDocument, text),
          ...(engineSessionId !== undefined ? { engineSessionId } : {}),
          serverUrl: this.options.serverUrl ?? '',
          mcpScriptPath: this.options.mcpScriptPath ?? '',
          agentName: this.options.agentName ?? PLANNER_AGENT_NAME,
          ...(modelFor(settings, this.options.agentName ?? PLANNER_AGENT_NAME)
            ? { model: modelFor(settings, this.options.agentName ?? PLANNER_AGENT_NAME) }
            : {}),
          timeoutMs: this.options.timeoutMs,
        };
      },
      onEvent: (key, event) => this.onEngineEvent(key, event),
      onFailure: async (key, outcome) => {
        const { projectId, sessionId } = splitTurnKey(key);
        // The desktop's send-lock clears on the next agent message; a
        // failed turn publishes the failure as one so the UI unblocks.
        await this.publishAgentMessage(
          key,
          projectId,
          sessionId,
          `failure:${sessionId}`,
          `The planner turn failed: ${outcome.error ?? 'unknown error'}`,
        );
      },
      nextQueued: (key, count) => {
        const { projectId, sessionId } = splitTurnKey(key);
        return nextQueuedMessage(() => {
          const found = this.sessionOf(projectId, sessionId);
          return found === undefined ? undefined : found.session;
        }, count);
      },
      userCount: (key) => {
        const { projectId, sessionId } = splitTurnKey(key);
        const found = this.sessionOf(projectId, sessionId);
        return found === undefined ? 0 : userMessageCount(found.session.messages);
      },
    });
  }

  start(): void {
    this.coordinator.start((frame) => this.onFrame(frame));
  }

  stop(): void {
    this.coordinator.stop();
  }

  private onFrame(frame: EventFrame): Promise<void> {
    if (frame.eventType !== 'userMessageReceived') return Promise.resolve();
    const body = frame.body as { sessionId?: string; message?: { text?: string } };
    if (frame.projectId === undefined || body.sessionId === undefined) return Promise.resolve();
    return this.onUserMessage(frame.projectId, body.sessionId, body.message?.text ?? '');
  }

  private async onUserMessage(projectId: string, sessionId: string, text: string): Promise<void> {
    await this.coordinator.runTurn(turnKey(projectId, sessionId), text);
  }

  private onEngineEvent(key: string, event: AgentTurnEvent): void {
    if (event.kind === 'messageDelta') {
      const { projectId, sessionId } = splitTurnKey(key);
      const found = this.sessionOf(projectId, sessionId);
      if (!found) return;
      void this.bus.publish(projectId, 'agentMessageDelta', {
        sessionId,
        messageIndex: this.coordinator.indexes.reserve(key, event.messageId, found.session.messages),
        delta: event.delta,
      });
      return;
    }
    if (event.kind !== 'messageComplete') return;
    const { projectId, sessionId } = splitTurnKey(key);
    void this.publishAgentMessage(key, projectId, sessionId, event.messageId, event.text);
  }

  private async publishAgentMessage(
    key: string,
    projectId: string,
    sessionId: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    const found = this.sessionOf(projectId, sessionId);
    if (!found) return;
    const index = this.coordinator.indexes.reserve(key, messageId, found.session.messages);
    await this.bus.publish(projectId, 'agentMessageComplete', {
      sessionId,
      message: { index, role: 'agent', text, at: nowIso() },
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
}

function buildPrompt(document: string, text: string): string {
  const documentBlock = document === '' ? '(the document is empty)' : document;
  return `Current plan document:\n\n${documentBlock}\n\nThe user says:\n\n${text}`;
}

/**
 * t10: a restart drops in-flight turns — a drafting session whose
 * transcript ends with a user message lost its turn (no agent reply will
 * ever come for it). Publish one failure message per stranded session so
 * the transcript is coherent and the desktop's send-lock clears. The next
 * real turn's prompt carries the whole transcript, so nothing is lost.
 */
export async function resumeStrandedTurns(bus: Bus): Promise<number> {
  let resumed = 0;
  for (const [projectId, project] of bus.state.byProject) {
    for (const session of project.planningSessions.values()) {
      if (session.status !== 'drafting') continue;
      const last = session.messages.at(-1);
      if (last === undefined || last.role !== 'user') continue;
      await bus.publish(projectId, 'agentMessageComplete', {
        sessionId: session.id,
        message: {
          index: nextMessageIndex(session.messages),
          role: 'agent',
          text: 'the server restarted before this turn could run — send your message again',
          at: nowIso(),
        },
      });
      resumed++;
    }
  }
  return resumed;
}