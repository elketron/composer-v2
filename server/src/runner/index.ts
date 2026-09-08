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
//
// The folder splits the surface: the shared types (types.ts), the command
// and agent step bodies (command-step.ts, agent-step.ts), the worker
// prompts (prompts.ts), and the drive loop here.

import type { Bus } from '../bus.js';
import type { Processor } from '../processor/index.js';
import type { EventFrame } from '../wire/envelope.js';
import { Board } from '../domain/board.js';
import type { AgentEngine } from '../engine/types.js';
import type { Card, Pipeline, PipelineStage, PipelineStep } from '../wire/models.js';
import { runAgentStep } from './agent-step.js';
import { runCommandStep } from './command-step.js';
import { outcomeBriefOf, stageOrderOf } from './prompts.js';
import type { GateDecision, OutcomeReport, RunTask, RunnerOptions } from './types.js';

export type { RunnerOptions } from './types.js';

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
          ? await runCommandStep(this.bus, task, step, this.options.commandTimeoutMs)
          : step.kind === 'agent'
            ? await runAgentStep(this.bus, this.engine, this.options, task, step, outcomeBriefOf(pipeline, stage))
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

  private cardOf(projectId: string, cardId: string): Card | undefined {
    return this.bus.state.byProject.get(projectId)?.cards.get(cardId);
  }
}
