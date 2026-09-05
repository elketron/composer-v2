// The pipeline runner (S3): one in-process sequential task per run — no
// durable runs (D5). Steps execute in order: `command` (child process in
// the project directory, output captured, wall-clock cap), `agent` (the
// engine; agentKind names the shipped agent), `human` (the run parks
// `waiting`; the gate command resolves it). Lane + sub-state are the
// board's progress projection (v1 on_step_started/on_step_finished
// semantics): agent → implement lane, command → validation, human →
// approval, all override moves.
//
// A failed step fails the run (the card's retries record it via the
// fold); the user re-runs. Stop kills the current child — the cancelled
// `pipelineRunEnded` is already on the stream, so the task exits without
// publishing anything more. Boot cancels interrupted runs.

import { spawn, type ChildProcess } from 'node:child_process';
import type { Bus } from './bus.js';
import { allocateId, type Processor } from './processor.js';
import { stepStageOf } from './fold.js';
import type { EventFrame } from './wire/envelope.js';
import { nowIso } from './wire/envelope.js';
import { ensureAgentFiles } from './agents.js';
import { resolveModel } from './store.js';
import type { AgentEngine, AgentTurnEvent, AgentTurnSpec } from './engine/types.js';
import type { Card, Pipeline, PipelineStep } from './wire/models.js';

export interface RunnerOptions {
  /** Composer's HTTP base (the MCP tools' callback target). */
  serverUrl?: string;
  /** Absolute path to composer's MCP server script. */
  mcpScriptPath?: string;
  /** Wall-clock cap per command step (default 10 minutes). */
  commandTimeoutMs?: number;
  /** Wall-clock cap per agent step (default 10 minutes). */
  agentTimeoutMs?: number;
  /** The settings provider — the model override rides each agent step's spec. */
  getModel?: () => Promise<{ model?: string }> | { model?: string };
}

interface GateDecision {
  approved: boolean;
  comment?: string;
}

/** One live run: the drive task's coordination state. */
interface RunTask {
  projectId: string;
  cardId: string;
  pipelineId: string;
  stopped: boolean;
  child: ChildProcess | null;
  abort: AbortController;
  resolveGate: ((decision: GateDecision | 'cancelled') => void) | null;
}

export class PipelineRunner {
  private readonly bus: Bus;
  private readonly processor: Processor;
  private readonly engine: AgentEngine;
  private readonly options: Required<Pick<RunnerOptions, 'commandTimeoutMs' | 'agentTimeoutMs'>> & RunnerOptions;
  private readonly tasks = new Map<string, RunTask>();
  private readonly agentSessions = new Map<string, string>();
  private unsubscribe: (() => void) | null = null;
  private runCounter = 0;

  constructor(
    bus: Bus,
    processor: Processor,
    engine: AgentEngine,
    options: RunnerOptions = {},
  ) {
    this.bus = bus;
    this.processor = processor;
    this.engine = engine;
    this.options = {
      commandTimeoutMs: options.commandTimeoutMs ?? 600_000,
      agentTimeoutMs: options.agentTimeoutMs ?? 600_000,
      ...options,
    };
  }

  start(): void {
    this.unsubscribe = this.bus.subscribe((frame) => {
      void this.onFrame(frame).catch((error) => console.error('runner:', error));
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const task of this.tasks.values()) {
      task.stopped = true;
      task.abort.abort();
      task.child?.kill('SIGKILL');
      task.resolveGate?.('cancelled');
    }
    this.tasks.clear();
  }

  private async onFrame(frame: EventFrame): Promise<void> {
    switch (frame.eventType) {
      case 'pipelineRunStarted': {
        const body = frame.body as { cardId?: string; pipelineId?: string };
        if (frame.projectId === undefined || body.cardId === undefined || body.pipelineId === undefined) return;
        await this.startRun(frame.projectId, body.cardId, body.pipelineId);
        return;
      }
      case 'pipelineGateResponded': {
        const body = frame.body as { cardId?: string; approved?: boolean; comment?: string };
        if (body.cardId === undefined) return;
        const task = this.tasks.get(body.cardId);
        task?.resolveGate?.({ approved: body.approved ?? false, ...(body.comment !== undefined ? { comment: body.comment } : {}) });
        return;
      }
      case 'pipelineRunEnded': {
        const body = frame.body as { cardId?: string; status?: string };
        if (body.status !== 'cancelled' || body.cardId === undefined) return;
        const task = this.tasks.get(body.cardId);
        if (task === undefined) return;
        // The cancelled runEnded is on the stream; the task exits without
        // publishing anything more (v1 semantics). A parked card stays put.
        task.stopped = true;
        task.abort.abort();
        task.child?.kill('SIGKILL');
        task.resolveGate?.('cancelled');
        this.tasks.delete(body.cardId);
        return;
      }
      default:
        return;
    }
  }

  private async startRun(projectId: string, cardId: string, pipelineId: string): Promise<void> {
    if (this.tasks.has(cardId)) return;
    const pipeline = this.bus.state.byProject.get(projectId)?.pipelines.get(pipelineId);
    if (pipeline === undefined) return;
    const task: RunTask = {
      projectId,
      cardId,
      pipelineId,
      stopped: false,
      child: null,
      abort: new AbortController(),
      resolveGate: null,
    };
    this.tasks.set(cardId, task);
    const runSeq = ++this.runCounter;
    try {
      await this.drive(task, pipeline, runSeq);
    } finally {
      this.tasks.delete(cardId);
    }
  }

  private async drive(task: RunTask, pipeline: Pipeline, runSeq: number): Promise<void> {
    const { projectId, cardId } = task;
    let gate: GateDecision | null = null;

    for (const [index, step] of pipeline.steps.entries()) {
      if (task.stopped) return;

      // The gate's resolver is armed BEFORE the step's start event — the
      // fold flips the run to `waiting` mid-publish, and a gate answer
      // that arrives from then on must find the resolver in place (v1's
      // GATE_WAKE_ATTEMPTS retry, solved by ordering here).
      const gatePromise = step.kind === 'human' ? this.prepareGate(task) : null;
      await this.bus.publish(projectId, 'pipelineStepStarted', {
        cardId,
        pipelineId: pipeline.id,
        stepId: step.id,
        kind: step.kind,
      });
      // The board's progress projection: the lane move and the stage's
      // sub-state go running (v1 on_step_started; override moves).
      const lane = laneFor(step, this.cardOf(projectId, cardId));
      await this.processor.execute(projectId, {
        type: 'requestCardMove',
        cardId,
        toLane: lane,
        override: true,
      });
      await this.processor.execute(projectId, {
        type: 'requestSubStateUpdate',
        cardId,
        stage: stepStageOf(step.kind),
        status: 'running',
      });

      const result:
        | { ok: true; decision?: GateDecision }
        | { ok: false; error: string } =
        step.kind === 'command'
          ? await this.runCommandStep(task, step)
          : step.kind === 'agent'
            ? await this.runAgentStep(task, step, runSeq, index)
            : await gatePromise!;

      if (task.stopped) return;
      await this.bus.publish(projectId, 'pipelineStepFinished', {
        cardId,
        pipelineId: pipeline.id,
        stepId: step.id,
        ok: result.ok,
        ...(result.ok ? {} : { error: result.error }),
      });
      await this.processor.execute(projectId, {
        type: 'requestSubStateUpdate',
        cardId,
        stage: stepStageOf(step.kind),
        status: result.ok ? 'ok' : 'failed',
      });
      if (!result.ok) {
        // A failed step fails the run (D5): the user re-runs.
        await this.bus.publish(projectId, 'pipelineRunEnded', {
          cardId,
          pipelineId: pipeline.id,
          status: 'failed',
          error: result.error,
        });
        return;
      }
      if (step.kind === 'human' && result.decision !== undefined) {
        gate = result.decision;
      }
    }

    await this.bus.publish(projectId, 'pipelineRunEnded', {
      cardId,
      pipelineId: pipeline.id,
      status: 'completed',
    });
    // The terminal routing rides after the run's end (v1 stream order):
    // an approval gate's decision moves the card — Done on approval, back
    // to the implement lane with the comment on rejection; anything else
    // stays put.
    const last = pipeline.steps.at(-1);
    if (last?.kind === 'human' && gate !== null) {
      const card = this.cardOf(projectId, cardId);
      if (card !== undefined) {
        if (gate.approved) {
          await this.moveCard(projectId, cardId, 'done');
        } else {
          await this.moveCard(projectId, cardId, implementLaneOf(card.type), gate.comment);
        }
      }
    }
  }

  // ---- Step bodies ----

  private async runCommandStep(
    task: RunTask,
    step: PipelineStep,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const directory = this.bus.state.projects.get(task.projectId)?.directory;
    if (directory === undefined) {
      return { ok: false, error: `Project ${task.projectId} has no directory set` };
    }
    return await new Promise((resolve) => {
      const child = spawn('/bin/sh', ['-c', step.command ?? ''], { cwd: directory });
      task.child = child;
      let output = '';
      // Live output rides ephemeral `commandOutput` events (live-only, like
      // agent deltas) — capped so a chatty build can't flood the stream.
      const MAX_LIVE_LINES = 400;
      let liveLines = 0;
      let lineBuffer = '';
      const streamLines = (chunk: string): void => {
        lineBuffer += chunk;
        let index: number;
        while ((index = lineBuffer.indexOf('\n')) >= 0) {
          const line = lineBuffer.slice(0, index);
          lineBuffer = lineBuffer.slice(index + 1);
          if (liveLines < MAX_LIVE_LINES) {
            liveLines++;
            void this.bus
              .publish(task.projectId, 'commandOutput', {
                cardId: task.cardId,
                pipelineId: task.pipelineId,
                stepId: step.id,
                line,
              })
              .catch(() => undefined);
          }
        }
      };
      const capture = (chunk: Buffer): void => {
        const text = chunk.toString();
        output = (output + text).slice(-8_000);
        streamLines(text);
      };
      child.stdout?.on('data', capture);
      child.stderr?.on('data', capture);
      const timeout = setTimeout(() => child.kill('SIGKILL'), this.options.commandTimeoutMs);
      timeout.unref?.();
      child.on('error', (error) => {
        clearTimeout(timeout);
        resolve({ ok: false, error: `command failed to start: ${String(error)}` });
      });
      child.on('close', (code, signal) => {
        clearTimeout(timeout);
        task.child = null;
        if (task.stopped) {
          resolve({ ok: false, error: 'the run was stopped' });
          return;
        }
        if (code === 0) {
          resolve({ ok: true });
          return;
        }
        const detail = output.trim().split('\n').at(-1) ?? '';
        const reason = signal !== null ? `killed by ${signal}` : `exit code ${code}`;
        resolve({ ok: false, error: detail !== '' ? `${reason}: ${detail}` : reason });
      });
    });
  }

  private async runAgentStep(
    task: RunTask,
    step: PipelineStep,
    runSeq: number,
    stepIndex: number,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const directory = this.bus.state.projects.get(task.projectId)?.directory;
    const card = this.cardOf(task.projectId, task.cardId);
    if (directory === undefined) {
      return { ok: false, error: `Project ${task.projectId} has no directory set` };
    }
    if (card === undefined) {
      return { ok: false, error: `Card ${task.cardId} vanished` };
    }
    // The shipped agent the step names; ship it if absent.
    try {
      ensureAgentFiles(directory);
    } catch (error) {
      return { ok: false, error: `could not ship agent files: ${String(error)}` };
    }

    const sessionId = allocateId(this.bus.state.byProject.get(task.projectId)?.agentSessions.keys() ?? [], 'A');
    await this.bus.publish(task.projectId, 'agentSessionStarted', {
      cardId: task.cardId,
      sessionId,
      agentKind: step.agentKind ?? 'coder',
      startedAt: nowIso(),
    });
    this.agentSessions.set(`${runSeq}:${step.id}`, sessionId);

    const settings = (await this.options.getModel?.()) ?? {};
    const agentKind = step.agentKind ?? 'coder';
    const model = resolveModel(settings, agentKind);
    const spec: AgentTurnSpec = {
      projectId: task.projectId,
      sessionId,
      projectDirectory: directory,
      prompt: coderPrompt(card, step),
      serverUrl: this.options.serverUrl ?? '',
      mcpScriptPath: this.options.mcpScriptPath ?? '',
      agentName: `composer-${agentKind}`,
      ...(model ? { model } : {}),
      timeoutMs: this.options.agentTimeoutMs,
      signal: task.abort.signal,
    };
    const onEvent = (event: AgentTurnEvent): void => {
      if (event.kind === 'toolCall') {
        void this.bus
          .publish(task.projectId, 'agentToolCall', {
            sessionId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            ...(event.args !== undefined ? { args: event.args as Record<string, unknown> } : {}),
          })
          .catch((error) => console.error('runner: failed to publish a tool call:', error));
        return;
      }
      if (event.kind === 'toolResult') {
        void this.bus
          .publish(task.projectId, 'agentToolResult', {
            sessionId,
            toolCallId: event.toolCallId,
            content: event.content,
            isError: event.isError,
          })
          .catch((error) => console.error('runner: failed to publish a tool result:', error));
        return;
      }
      const body =
        event.kind === 'messageDelta'
          ? { sessionId, messageIndex: this.nextAgentMessageIndex(sessionId), delta: event.delta }
          : {
              sessionId,
              message: {
                index: this.nextAgentMessageIndex(sessionId),
                role: 'agent',
                text: event.text,
                at: nowIso(),
              },
            };
      void this.bus
        .publish(task.projectId, event.kind === 'messageDelta' ? 'agentMessageDelta' : 'agentMessageComplete', body)
        .catch((error) => console.error('runner: failed to publish an agent event:', error));
    };
    const outcome = await this.engine.run(spec, onEvent);

    await this.bus.publish(task.projectId, 'agentSessionEnded', {
      cardId: task.cardId,
      sessionId,
      status: outcome.ok ? 'ended' : 'failed',
      ...(outcome.ok ? {} : { error: outcome.error }),
      endedAt: nowIso(),
    });
    return outcome.ok ? { ok: true } : { ok: false, error: outcome.error ?? 'the agent step failed' };
  }

  /** Arms the gate resolver; the returned promise settles on the decision. */
  private prepareGate(task: RunTask): Promise<{ ok: true; decision: GateDecision } | { ok: false; error: string }> {
    return new Promise((resolve) => {
      task.resolveGate = (decision) => {
        task.resolveGate = null;
        if (decision === 'cancelled') {
          resolve({ ok: false, error: 'the run was stopped' });
          return;
        }
        resolve({ ok: true, decision });
      };
    });
  }

  // ---- Helpers ----

  private cardOf(projectId: string, cardId: string): Card | undefined {
    return this.bus.state.byProject.get(projectId)?.cards.get(cardId);
  }

  private nextAgentMessageIndex(sessionId: string): number {
    const session = [...this.bus.state.byProject.values()]
      .flatMap((project) => [...project.agentSessions.values()])
      .find((session) => session.id === sessionId);
    const messages = session?.transcript.filter((entry) => entry.kind === 'message') ?? [];
    return messages.reduce((max, entry) => (entry.kind === 'message' ? Math.max(max, entry.message.index) : max), 0) + 1;
  }

  private async moveCard(projectId: string, cardId: string, toLane: Card['stage'], comment?: string): Promise<void> {
    await this.processor.execute(projectId, {
      type: 'requestCardMove',
      cardId,
      toLane,
      override: true,
      ...(comment !== undefined ? { comment } : {}),
    });
  }
}

/** The lane a step works in (v1 on_step_started). */
function laneFor(step: PipelineStep, card: Card | undefined): Card['stage'] {
  switch (step.kind) {
    case 'agent':
      return card !== undefined ? implementLaneOf(card.type) : 'coding';
    case 'command':
      return 'validation';
    case 'human':
      return 'approval';
  }
}

function implementLaneOf(type: Card['type']): Card['stage'] {
  switch (type) {
    case 'coding':
      return 'coding';
    case 'design':
      return 'design';
    case 'docs':
      return 'docs';
  }
}

/** The coder's brief: the card is the work order; the runtime's own tools are the surface. */
function coderPrompt(card: Card, step: PipelineStep): string {
  const instructions = step.instructions?.trim() !== '' ? step.instructions!.trim() : 'Implement the card.';
  const blockers =
    card.blockedBy.length > 0 ? `\n\nBlockers (already satisfied): ${card.blockedBy.join(', ')}` : '';
  return [
    `Implement card ${card.id}: ${card.title}`,
    '',
    card.description.trim() !== '' ? card.description : '(no description)',
    blockers,
    '',
    `Instructions: ${instructions}`,
    '',
    'Work in the current directory with your own file and shell tools. Keep the change minimal and make the relevant checks pass.',
  ]
    .filter((part) => part !== undefined)
    .join('\n');
}
