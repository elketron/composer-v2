// The pipeline runner (S3, staged in Phase 10): one in-process sequential
// task per run — no durable runs (D5). A run is a first-class record (R-N)
// pinned to the pipeline revision it started on, and it executes the steps
// whose stage is at or after the card's current stage: each step's start
// moves the card to the step's stage (the fold applies it; hidden stages
// project to the previous visible column client-side), and finishing the
// last step moves the card to the terminal stage.
//
// Step kinds: `command` (child process in the project directory, output
// captured, wall-clock cap), `agent` (the engine; agentKind names the
// shipped worker), `human` (the run parks `waiting`; the gate command
// resolves it). A failed step ends the run `failed` — unless the step's
// stage configures an error return, in which case the card moves to that
// earlier stage and the run ends `returned`. A rejected gate behaves the
// same way. An agent stage may define named outcomes (S36): the agent
// reports one through the outcome tool mid-turn; a backward rule moves
// the card and ends the run `returned`, a forward rule proceeds, and a
// stage that requires the outcome fails a turn without the call. Stop
// kills the current child — the cancelled `pipelineRunEnded` is already
// on the stream, so the task exits without publishing more. Boot cancels
// interrupted runs.

import { spawn, type ChildProcess } from 'node:child_process';
import type { Bus } from './bus.js';
import { allocateId, type Processor } from './processor.js';
import type { EventFrame } from './wire/envelope.js';
import { nowIso } from './wire/envelope.js';
import { ensureAgentFiles } from './agents.js';
import { resolveModel } from './store.js';
import type { AgentEngine, AgentTurnEvent, AgentTurnSpec } from './engine/types.js';
import type { Card, Pipeline, PipelineStage, PipelineStep } from './wire/models.js';
import { Board } from './domain/board.js';

export interface RunnerOptions {
  /** Composer's HTTP base (the MCP tools' callback target). */
  serverUrl?: string;
  /** Absolute path to the worker MCP server script (dist/worker-mcp.js). */
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

/** One outcome report recorded for the run's current agent step (S36). */
interface OutcomeReport {
  stepId: string;
  outcome: string;
  note?: string;
}

/** One live run: the drive task's coordination state. */
interface RunTask {
  projectId: string;
  runId: string;
  cardId: string;
  pipelineId: string;
  stopped: boolean;
  child: ChildProcess | null;
  abort: AbortController;
  resolveGate: ((decision: GateDecision | 'cancelled') => void) | null;
  /** The agent's reported outcome for the current step, if one landed. */
  outcome: OutcomeReport | null;
}

export class PipelineRunner {
  private readonly bus: Bus;
  private readonly processor: Processor;
  private readonly engine: AgentEngine;
  private readonly options: Required<Pick<RunnerOptions, 'commandTimeoutMs' | 'agentTimeoutMs'>> & RunnerOptions;
  private readonly tasks = new Map<string, RunTask>();
  private unsubscribe: (() => void) | null = null;

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
    // The tasks stay in the map: each drive removes its own task in its
    // finally, which is exactly the unwind signal drain() waits on.
  }

  // Resolves once every started run has fully unwound (the task leaves the
  // map only after drive's last publish resolved) — teardown uses this so
  // no in-flight append races a closing EventStore.
  async drain(): Promise<void> {
    while (this.tasks.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  private async onFrame(frame: EventFrame): Promise<void> {
    switch (frame.eventType) {
      case 'pipelineRunStarted': {
        const body = frame.body as {
          runId?: string;
          cardId?: string;
          pipelineId?: string;
          revision?: number;
        };
        if (
          frame.projectId === undefined ||
          body.runId === undefined ||
          body.cardId === undefined ||
          body.pipelineId === undefined
        ) {
          return;
        }
        await this.startRun(frame.projectId, body.runId, body.cardId, body.pipelineId, body.revision);
        return;
      }
      case 'pipelineGateResponded': {
        const body = frame.body as { runId?: string; cardId?: string; approved?: boolean; comment?: string };
        const runId = body.runId ?? (body.cardId !== undefined ? this.bus.state.byProject.get(frame.projectId ?? '')?.activeRuns.get(body.cardId) : undefined);
        if (runId === undefined) return;
        const task = this.tasks.get(runId);
        task?.resolveGate?.({ approved: body.approved ?? false, ...(body.comment !== undefined ? { comment: body.comment } : {}) });
        return;
      }
      case 'pipelineRunEnded': {
        const body = frame.body as { runId?: string; cardId?: string; status?: string };
        if (body.status !== 'cancelled' || body.runId === undefined) return;
        const task = this.tasks.get(body.runId);
        if (task === undefined) return;
        // The cancelled runEnded is on the stream; the task exits without
        // publishing anything more (v1 semantics). A parked card stays put.
        // The task stays in the map until drive's own finally removes it —
        // deleting here would hide an in-flight unwind from drain().
        task.stopped = true;
        task.abort.abort();
        task.child?.kill('SIGKILL');
        task.resolveGate?.('cancelled');
        return;
      }
      case 'pipelineOutcomeReported': {
        const body = frame.body as { runId?: string; stepId?: string; outcome?: string; note?: string };
        if (body.runId === undefined || body.stepId === undefined || body.outcome === undefined) return;
        const task = this.tasks.get(body.runId);
        if (task === undefined) return;
        task.outcome = {
          stepId: body.stepId,
          outcome: body.outcome,
          ...(body.note !== undefined ? { note: body.note } : {}),
        };
        return;
      }
      default:
        return;
    }
  }

  private async startRun(
    projectId: string,
    runId: string,
    cardId: string,
    pipelineId: string,
    revision: number | undefined,
  ): Promise<void> {
    if (this.tasks.has(runId)) return;
    const project = this.bus.state.byProject.get(projectId);
    if (project === undefined) return;
    // The pinned revision wins; a revision the fold no longer holds (or an
    // unnumbered run) falls back to the pipeline's current definition.
    const pipeline = Board.of(project).pipelineOfRun({ pipelineId, revision: revision ?? 0 });
    if (pipeline === undefined) return;
    const task: RunTask = {
      projectId,
      runId,
      cardId,
      pipelineId,
      stopped: false,
      child: null,
      abort: new AbortController(),
      resolveGate: null,
      outcome: null,
    };
    this.tasks.set(runId, task);
    try {
      await this.drive(task, pipeline);
    } finally {
      this.tasks.delete(runId);
    }
  }

  private async drive(task: RunTask, pipeline: Pipeline): Promise<void> {
    const { projectId, runId, cardId } = task;
    let gate: GateDecision | null = null;
    const card = this.cardOf(projectId, cardId);
    if (card === undefined) return;
    // The run executes from the card's current stage onward: steps in
    // earlier stages are skipped (a returned card reruns from where it sits).
    const fromOrder = stageOrderOf(pipeline, card.stageId);
    const steps = pipeline.steps.filter(
      (step) => stageOrderOf(pipeline, step.stageId) >= fromOrder,
    );

    for (const step of steps) {
      if (task.stopped) return;
      const stage = pipeline.stages.find((candidate) => candidate.id === step.stageId)!;

      // The gate's resolver is armed BEFORE the step's start event — the
      // fold flips the run to `waiting` mid-publish, and a gate answer
      // that arrives from then on must find the resolver in place (v1's
      // GATE_WAKE_ATTEMPTS retry, solved by ordering here).
      const gatePromise = step.kind === 'human' ? this.prepareGate(task) : null;
      await this.bus.publish(projectId, 'pipelineStepStarted', {
        runId,
        cardId,
        pipelineId: pipeline.id,
        stepId: step.id,
        kind: step.kind,
        stageId: step.stageId,
      });

      const result:
        | { ok: true; decision?: GateDecision; outcome?: OutcomeReport }
        | { ok: false; error: string } =
        step.kind === 'command'
          ? await this.runCommandStep(task, step)
          : step.kind === 'agent'
            ? await this.runAgentStep(task, step, outcomeBriefOf(pipeline, stage))
            : await gatePromise!;

      if (task.stopped) return;
      // The stage's outcome rules (S36) decide how a successful agent turn
      // settles: a backward outcome returns the card to the rule's stage
      // (the run ends `returned`, like a rejected gate — the note rides the
      // move as the rejection comment); a stage that requires the outcome
      // fails the step when the turn reported nothing.
      let failure: string | undefined = result.ok ? undefined : result.error;
      let returnTo: { target: string; report: OutcomeReport } | undefined;
      if (result.ok && step.kind === 'agent') {
        const reported = result.outcome;
        const rule =
          reported !== undefined
            ? (stage.outcomes ?? []).find((candidate) => candidate.outcome === reported.outcome)
            : undefined;
        if (reported !== undefined && rule?.toStageId !== undefined) {
          returnTo = { target: rule.toStageId, report: reported };
        } else if (reported === undefined && (stage.outcomes?.length ?? 0) > 0 && stage.requiresOutcome === true) {
          const names = (stage.outcomes ?? []).map((candidate) => candidate.outcome).join(', ');
          failure = `the stage requires an explicit outcome — call composer_report_outcome with one of: ${names}`;
        }
      }

      await this.bus.publish(projectId, 'pipelineStepFinished', {
        runId,
        cardId,
        pipelineId: pipeline.id,
        stepId: step.id,
        ok: failure === undefined,
        ...(failure !== undefined ? { error: failure } : {}),
      });
      if (failure !== undefined) {
        // A failed step fails the run — unless the step's stage configures
        // an error return, which moves the card to the earlier stage and
        // ends the run `returned` (the model's recovery rule).
        await this.endRun(task, pipeline, stage, 'failed', failure);
        return;
      }
      if (returnTo !== undefined) {
        const note = returnTo.report.note?.trim();
        await this.endRun(
          task,
          pipeline,
          stage,
          'returned',
          note ? `${returnTo.report.outcome}: ${note}` : `outcome '${returnTo.report.outcome}' returned the card`,
          note || undefined,
          returnTo.target,
        );
        return;
      }
      if (step.kind === 'human' && result.ok && result.decision !== undefined) {
        gate = result.decision;
        if (!gate.approved) {
          await this.endRun(
            task,
            pipeline,
            stage,
            'returned',
            gate.comment !== undefined && gate.comment.trim() !== ''
              ? `changes requested: ${gate.comment.trim()}`
              : 'changes requested at the approval gate',
            gate.comment,
          );
          return;
        }
      }
    }

    await this.bus.publish(projectId, 'pipelineRunEnded', {
      runId,
      cardId,
      pipelineId: pipeline.id,
      revision: pipeline.revision,
      status: 'completed',
    });
    // The completed run moves the card to the terminal stage (the model's
    // completion rule; the terminal stage is always the last).
    const terminal = pipeline.stages.at(-1);
    if (terminal !== undefined) {
      await this.bus.publish(projectId, 'cardStageMoved', {
        cardId,
        pipelineId: pipeline.id,
        toStageId: terminal.id,
      });
    }
  }

  /**
   * Ends a run and applies the recovery rule. A plain failure keeps the
   * card where it is; a return target — the stage's error-return condition
   * by default, or an outcome rule's earlier stage (S36) — moves the card
   * there and ends the run `returned`. The optional comment rides the card
   * move (the gate's rejection comment, the outcome's note).
   */
  private async endRun(
    task: RunTask,
    pipeline: Pipeline,
    stage: PipelineStage,
    status: 'failed' | 'returned',
    error: string,
    comment?: string,
    returnTo: string | undefined = stage.errorReturnToStageId,
  ): Promise<void> {
    if (returnTo !== undefined) {
      await this.bus.publish(task.projectId, 'cardStageMoved', {
        cardId: task.cardId,
        pipelineId: pipeline.id,
        fromStageId: stage.id,
        toStageId: returnTo,
        ...(comment !== undefined ? { comment } : {}),
      });
    }
    await this.bus.publish(task.projectId, 'pipelineRunEnded', {
      runId: task.runId,
      cardId: task.cardId,
      pipelineId: pipeline.id,
      revision: pipeline.revision,
      status: returnTo !== undefined ? 'returned' : status,
      ...(error !== '' ? { error } : {}),
    });
  }

  // ---- Step bodies ----

  private async runCommandStep(
    task: RunTask,
    step: PipelineStep,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    // A stop that landed while the drive was between awaits must not spawn
    // a child nobody will kill.
    if (task.stopped) return { ok: false, error: 'the run was stopped' };
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
                runId: task.runId,
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
    outcomeBrief: string | undefined,
  ): Promise<{ ok: true; outcome?: OutcomeReport } | { ok: false; error: string }> {
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
    // The outcome report belongs to this step only: anything a previous
    // step's agent reported is stale by definition.
    task.outcome = null;

    const sessionId = allocateId(this.bus.state.byProject.get(task.projectId)?.agentSessions.keys() ?? [], 'A');
    await this.bus.publish(task.projectId, 'agentSessionStarted', {
      cardId: task.cardId,
      sessionId,
      agentKind: step.agentKind ?? 'coder',
      startedAt: nowIso(),
    });

    const settings = (await this.options.getModel?.()) ?? {};
    const agentKind = step.agentKind ?? 'coder';
    const model = resolveModel(settings, agentKind);
    const spec: AgentTurnSpec = {
      projectId: task.projectId,
      sessionId,
      projectDirectory: directory,
      prompt: promptFor(agentKind, card, step, outcomeBrief),
      serverUrl: this.options.serverUrl ?? '',
      mcpScriptPath: this.options.mcpScriptPath ?? '',
      agentName: `composer-${agentKind}`,
      ...(model ? { model } : {}),
      timeoutMs: this.options.agentTimeoutMs,
      signal: task.abort.signal,
      // The workers' own surface: workflow recording + retrieval. The
      // planner's write tools stay the planner's.
      mcpTools: 'worker',
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
    if (!outcome.ok) {
      task.outcome = null;
      return { ok: false, error: outcome.error ?? 'the agent step failed' };
    }
    // A report recorded for this step rides the result; the drive applies
    // the stage's outcome rules to it.
    const reported = reportedOutcome(task, step.id);
    task.outcome = null;
    return { ok: true, ...(reported !== undefined ? { outcome: reported } : {}) };
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
}

/** A stage's forward order in its pipeline (absent = last, so unknown stages never skip ahead). */
function stageOrderOf(pipeline: Pipeline, stageId: string): number {
  const index = pipeline.stages.findIndex((stage) => stage.id === stageId);
  return index >= 0 ? index : pipeline.stages.length;
}

/** The run task's outcome report for one step, if one landed (a function read: property narrowing resets). */
function reportedOutcome(task: RunTask, stepId: string): OutcomeReport | undefined {
  return task.outcome?.stepId === stepId ? (task.outcome ?? undefined) : undefined;
}

/** The worker's brief: the card is the work order; the runtime's own tools are the surface. */
function promptFor(agentKind: string, card: Card, step: PipelineStep, outcomeBrief?: string): string {
  const instructions = step.instructions?.trim() !== '' ? step.instructions!.trim() : defaultInstructionOf(agentKind);
  const blockers =
    card.blockedBy.length > 0 ? `\n\nBlockers (already satisfied): ${card.blockedBy.join(', ')}` : '';
  const [verb, closing] = briefOf(agentKind);
  return [
    `${verb} card ${card.id}: ${card.title}`,
    '',
    card.description.trim() !== '' ? card.description : '(no description)',
    blockers,
    '',
    `Instructions: ${instructions}`,
    ...(outcomeBrief !== undefined ? ['', outcomeBrief] : []),
    '',
    closing,
  ]
    .filter((part) => part !== undefined)
    .join('\n');
}

/**
 * The agent brief's outcome section (S36): the stage's named outcomes and
 * what each does. Present only when the stage defines outcomes.
 */
function outcomeBriefOf(pipeline: Pipeline, stage: PipelineStage | undefined): string | undefined {
  const rules = stage?.outcomes ?? [];
  if (rules.length === 0) return undefined;
  const lines = rules.map((rule) => {
    const target =
      rule.toStageId !== undefined
        ? `the card returns to ${
            pipeline.stages.find((candidate) => candidate.id === rule.toStageId)?.label ?? rule.toStageId
          }`
        : 'the pipeline proceeds to the next step';
    return `- ${rule.outcome} — ${target}`;
  });
  return [
    "Outcomes: when the work is done, call `composer_report_outcome` with exactly one of this stage's outcome names:",
    ...lines,
    stage?.requiresOutcome === true
      ? 'This stage requires the call: a finished turn without it fails the step.'
      : 'The call is optional: a finished turn without it proceeds.',
  ].join('\n');
}

function defaultInstructionOf(agentKind: string): string {
  switch (agentKind) {
    case 'tester':
      return 'Verify the card.';
    case 'reviewer':
      return 'Review the card.';
    case 'security':
      return 'Security-review the card.';
    default:
      return 'Implement the card.';
  }
}

/** Per-worker opening verb and working rules (the coder's are v1's). */
function briefOf(agentKind: string): [string, string] {
  switch (agentKind) {
    case 'tester':
      return [
        'Verify',
        'Work in the current directory with your own file and shell tools. Confirm the implementation matches the card, write or extend the tests that prove it, and make the relevant checks pass.',
      ];
    case 'reviewer':
      return [
        'Review',
        'Review the working tree\'s change against the card — git diff is the first look. Judge correctness and fit; do not edit anything. Finish with a clear verdict: approved, or the changes the card still needs.',
      ];
    case 'security':
      return [
        'Security-review',
        'Security-review the working tree\'s change — git diff is the first look. Report the risks the change could introduce; never fix anything. Finish with a clear verdict: no findings, or each finding with its file and what must change.',
      ];
    default:
      return [
        'Implement',
        'Work in the current directory with your own file and shell tools. Keep the change minimal and make the relevant checks pass.',
      ];
  }
}
