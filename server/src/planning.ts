// The planning orchestrator: turns `userMessageReceived` events into agent
// turns (v1 planner route, sans the spect machinery). One engine turn per
// user message; turns serialize per session — a message that arrives while
// a turn is in flight is already folded into state and picked up by the
// turn loop's next run. Replies stream as `agentMessageDelta`; intermediate
// completions become turn activity and the final completion stays the normal
// reply. Document edits synchronize from a native-edit scratch file; ticket
// emission rides the planner MCP tool.
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  /** Ships the agent definitions into the project (defaults to `ensureAgentFiles`). */
  provision?: (directory: string) => void;
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
  private readonly turnParents = new Map<string, number>();
  private readonly lastCompletion = new Map<string, { messageId: string; text: string }>();
  private readonly activityWrites = new Map<string, Promise<void>>();
  private readonly workspaceRoot = mkdtempSync(join(tmpdir(), 'composer-planner-'));
  private readonly workspaces = new Map<string, string>();

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
        const found = this.sessionOf(projectId, sessionId);
        if (found === undefined) return;
        const directory = this.workspaceFor(key, found.session.planDocument);
        try {
          (this.options.provision ?? ensureAgentFiles)(directory);
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
          projectDirectory: this.workspaceFor(key, found.session.planDocument),
          planDocumentPath: this.planPath(key),
          prompt: buildPrompt(text, pipelineInventory(this.bus, projectId)),
          ...(engineSessionId !== undefined ? { engineSessionId } : {}),
          serverUrl: this.options.serverUrl ?? '',
          mcpScriptPath: this.options.mcpScriptPath ?? '',
          agentName: this.options.agentName ?? PLANNER_AGENT_NAME,
          mcpTools: 'planner',
          ...(modelFor(settings, this.options.agentName ?? PLANNER_AGENT_NAME)
            ? { model: modelFor(settings, this.options.agentName ?? PLANNER_AGENT_NAME) }
            : {}),
          timeoutMs: this.options.timeoutMs,
        };
      },
      beforeRun: (key) => {
        const { projectId, sessionId } = splitTurnKey(key);
        const user = [...(this.sessionOf(projectId, sessionId)?.session.messages ?? [])]
          .reverse()
          .find((message) => message.role === 'user');
        if (user !== undefined) this.turnParents.set(key, user.index);
      },
      onEvent: (key, event) => this.onEngineEvent(key, event),
      onFailure: async (key, outcome) => {
        const { projectId, sessionId } = splitTurnKey(key);
        await this.syncDocument(key);
        // The desktop's send-lock clears on the next agent message; a
        // failed turn publishes the failure as one so the UI unblocks.
        const buffered = this.lastCompletion.get(key);
        if (buffered !== undefined) this.promoteCompletion(key, buffered);
        await this.activityWrites.get(key);
        await this.publishAgentMessage(
          key,
          projectId,
          sessionId,
          `failure:${sessionId}`,
          `The planner turn failed: ${outcome.error ?? 'unknown error'}`,
        );
      },
      onSuccess: async (key) => {
        const { projectId, sessionId } = splitTurnKey(key);
        await this.syncDocument(key);
        const final = this.lastCompletion.get(key);
        this.lastCompletion.delete(key);
        await this.activityWrites.get(key);
        if (final !== undefined) {
          await this.publishAgentMessage(key, projectId, sessionId, final.messageId, final.text);
        }
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
      cleanup: (key) => {
        this.lastCompletion.delete(key);
        this.activityWrites.delete(key);
        this.turnParents.delete(key);
      },
    });
  }

  start(): void {
    this.coordinator.start((frame) => this.onFrame(frame));
  }

  stop(): void {
    this.coordinator.stop();
    rmSync(this.workspaceRoot, { recursive: true, force: true });
    this.workspaces.clear();
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
      const completed = this.lastCompletion.get(key);
      if (completed !== undefined && completed.messageId !== event.messageId) {
        this.promoteCompletion(key, completed);
      }
      void this.bus.publish(projectId, 'agentMessageDelta', {
        sessionId,
        messageIndex: this.coordinator.indexes.reserve(key, event.messageId, found.session.messages),
        delta: event.delta,
      });
      return;
    }
    if (event.kind === 'toolCall') {
      const { projectId, sessionId } = splitTurnKey(key);
      this.enqueueActivity(key, () =>
        this.bus.publish(projectId, 'agentToolCall', {
          sessionId,
          ...(this.turnParents.get(key) !== undefined
            ? { parentIndex: this.turnParents.get(key) }
            : {}),
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        }),
      );
      return;
    }
    if (event.kind === 'toolResult') {
      const { projectId, sessionId } = splitTurnKey(key);
      this.enqueueActivity(key, () =>
        this.bus.publish(projectId, 'agentToolResult', {
          sessionId,
          toolCallId: event.toolCallId,
          content: capActivitySummary(event.content),
          isError: event.isError,
        }),
      );
      return;
    }
    if (event.kind !== 'messageComplete') return;
    const previous = this.lastCompletion.get(key);
    if (previous !== undefined && previous.messageId !== event.messageId) {
      this.promoteCompletion(key, previous);
    }
    this.lastCompletion.set(key, { messageId: event.messageId, text: event.text });
  }

  private promoteCompletion(key: string, completion: { messageId: string; text: string }): void {
    this.lastCompletion.delete(key);
    const { projectId, sessionId } = splitTurnKey(key);
    this.enqueueActivity(key, () =>
      this.publishAgentMessage(key, projectId, sessionId, completion.messageId, completion.text, true),
    );
  }

  private enqueueActivity(key: string, write: () => Promise<unknown>): void {
    const previous = this.activityWrites.get(key) ?? Promise.resolve();
    this.activityWrites.set(key, previous.then(write).then(() => undefined));
  }

  private async publishAgentMessage(
    key: string,
    projectId: string,
    sessionId: string,
    messageId: string,
    text: string,
    activity = false,
  ): Promise<void> {
    const found = this.sessionOf(projectId, sessionId);
    if (!found) return;
    const index = this.coordinator.indexes.reserve(key, messageId, found.session.messages);
    await this.bus.publish(projectId, 'agentMessageComplete', {
      sessionId,
      message: {
        index,
        role: 'agent',
        text,
        at: nowIso(),
        ...(activity ? { activity: true } : {}),
        ...(activity && this.turnParents.get(key) !== undefined
          ? { parentIndex: this.turnParents.get(key) }
          : {}),
      },
    });
  }

  private sessionOf(projectId: string, sessionId: string) {
    const session = this.bus.state.byProject.get(projectId)?.planningSessions.get(sessionId);
    if (!session) return undefined;
    return { session: structuredClone(session) };
  }

  private workspaceFor(key: string, document: string): string {
    let directory = this.workspaces.get(key);
    if (directory === undefined) {
      directory = join(this.workspaceRoot, key.replaceAll('/', '-'));
      mkdirSync(directory, { recursive: true });
      this.workspaces.set(key, directory);
    }
    const path = join(directory, 'plan.md');
    if (!existsSync(path)) writeFileSync(path, document);
    return directory;
  }

  private planPath(key: string): string {
    return join(this.workspaces.get(key) ?? '', 'plan.md');
  }

  private async syncDocument(key: string): Promise<void> {
    const { projectId, sessionId } = splitTurnKey(key);
    const found = this.sessionOf(projectId, sessionId);
    const directory = this.workspaces.get(key);
    if (found === undefined || found.session.status !== 'drafting' || directory === undefined) return;
    const document = readFileSync(join(directory, 'plan.md'), 'utf8');
    if (document === found.session.planDocument) return;
    await this.bus.publish(projectId, 'planDocumentUpdated', { sessionId, document });
  }
}

const ACTIVITY_SUMMARY_CAP = 2_000;

function capActivitySummary(content: string): string {
  return content.length <= ACTIVITY_SUMMARY_CAP
    ? content
    : `${content.slice(0, ACTIVITY_SUMMARY_CAP)}…`;
}

function buildPrompt(text: string, pipelines: string): string {
  return `Edit plan.md for this turn. Do not return the document as chat.\n\nAvailable target pipelines:\n${pipelines}\n\nThe user says:\n\n${text}`;
}

function pipelineInventory(bus: Bus, projectId: string): string {
  const pipelines = bus.state.byProject.get(projectId)?.pipelines;
  if (pipelines === undefined || pipelines.size === 0) return '(none)';
  return [...pipelines.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((pipeline) => {
      const lanes = pipeline.steps.filter((step) => step.boardVisible).map((step) => `${step.id}: ${step.label}`);
      return `- ${pipeline.id}: ${pipeline.name} [${lanes.join(', ')}]`;
    })
    .join('\n');
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
