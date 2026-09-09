// Drives one pinned pipeline run through its steps and applies completion
// and recovery transitions.

import type { Bus } from '../bus.js';
import type { AgentEngine } from '../engine/types.js';
import type { Pipeline, PipelineStep } from '../wire/models.js';
import { runAgentStep } from './agent-step.js';
import { runCommandStep } from './command-step.js';
import { outcomeBriefOf, stepOrderOf } from './prompts.js';
import type { GateDecision, OutcomeReport, RunTask, RunnerOptions } from './types.js';

export async function drivePipeline(
  bus: Bus,
  engine: AgentEngine,
  options: Required<Pick<RunnerOptions, 'commandTimeoutMs' | 'agentTimeoutMs'>> & RunnerOptions,
  task: RunTask,
  pipeline: Pipeline,
): Promise<void> {
  const { projectId, runId, cardId } = task;
  let gate: GateDecision | null = null;
  const card = bus.state.byProject.get(projectId)?.cards.get(cardId);
  if (card === undefined) return;
  // A returned card reruns from its current step; earlier steps are skipped.
  const fromOrder = stepOrderOf(pipeline, card.stepId);
  const steps = pipeline.steps.filter(
    (step, index) => index >= fromOrder && step.terminal !== true,
  );

  for (const step of steps) {
    if (task.stopped) return;

    // Arm the gate before publishing the waiting transition so an immediate
    // response always finds its resolver.
    const gatePromise = step.kind === 'human' ? prepareGate(task) : null;
    await bus.publish(projectId, 'pipelineStepStarted', {
      runId,
      cardId,
      pipelineId: pipeline.id,
      stepId: step.id,
      kind: step.kind,
    });

    const result:
      | { ok: true; decision?: GateDecision; outcome?: OutcomeReport }
      | { ok: false; error: string } =
      step.kind === 'command'
        ? await runCommandStep(bus, task, step, options.commandTimeoutMs)
        : step.kind === 'agent'
          ? await runAgentStep(bus, engine, options, task, step, outcomeBriefOf(pipeline, step))
          : await gatePromise!;

    if (task.stopped) return;
    let failure: string | undefined = result.ok ? undefined : result.error;
    let returnTo: { target: string; report: OutcomeReport } | undefined;
    if (result.ok && step.kind === 'agent') {
      const reported = result.outcome;
      const rule = reported !== undefined
        ? (step.outcomes ?? []).find((candidate) => candidate.outcome === reported.outcome)
        : undefined;
      if (reported !== undefined && rule?.toStepId !== undefined) {
        returnTo = { target: rule.toStepId, report: reported };
      } else if (reported === undefined && (step.outcomes?.length ?? 0) > 0 && step.requiresOutcome === true) {
        const names = (step.outcomes ?? []).map((candidate) => candidate.outcome).join(', ');
        failure = `the step requires an explicit outcome — call composer_report_outcome with one of: ${names}`;
      }
    }

    await bus.publish(projectId, 'pipelineStepFinished', {
      runId,
      cardId,
      pipelineId: pipeline.id,
      stepId: step.id,
      ok: failure === undefined,
      ...(failure !== undefined ? { error: failure } : {}),
    });
    if (failure !== undefined) {
      await endRunFailed(bus, task, pipeline, step, failure, step.errorReturnToStepId);
      return;
    }
    if (returnTo !== undefined) {
      const note = returnTo.report.note?.trim();
      await endRunOutcome(
        bus,
        task,
        pipeline,
        step,
        returnTo.report.outcome,
        note || undefined,
        returnTo.target,
      );
      return;
    }
    if (step.kind === 'human' && result.ok && result.decision !== undefined) {
      gate = result.decision;
      if (!gate.approved) {
        const feedback = gate.comment !== undefined && gate.comment.trim() !== ''
          ? gate.comment.trim()
          : 'changes requested at the approval gate';
        await endRunOutcome(bus, task, pipeline, step, 'changes_requested', feedback, step.errorReturnToStepId);
        return;
      }
    }
  }

  await bus.publish(projectId, 'pipelineRunEnded', {
    runId,
    cardId,
    pipelineId: pipeline.id,
    revision: pipeline.revision,
    status: 'completed',
  });
  const terminal = pipeline.steps.at(-1);
  if (terminal !== undefined) {
    await bus.publish(projectId, 'cardStepMoved', {
      cardId,
      pipelineId: pipeline.id,
      toStepId: terminal.id,
    });
  }
}

/**
 * A successful named outcome (or a human gate rejection) routed the card
 * backward: the step succeeded, the feedback rides the card back to the
 * coder, and the run ends as a non-failure outcome route — never an error.
 */
async function endRunOutcome(
  bus: Bus,
  task: RunTask,
  pipeline: Pipeline,
  step: PipelineStep,
  outcome: string,
  feedback: string | undefined,
  routedTo: string | undefined,
): Promise<void> {
  if (routedTo !== undefined) {
    await bus.publish(task.projectId, 'cardStepMoved', {
      cardId: task.cardId,
      pipelineId: pipeline.id,
      fromStepId: step.id,
      toStepId: routedTo,
      ...(feedback !== undefined ? { comment: feedback } : {}),
    });
  }
  await bus.publish(task.projectId, 'pipelineRunEnded', {
    runId: task.runId,
    cardId: task.cardId,
    pipelineId: pipeline.id,
    revision: pipeline.revision,
    status: 'returned',
    outcome,
    ...(feedback !== undefined ? { feedback } : {}),
    ...(routedTo !== undefined ? { routedToStepId: routedTo } : {}),
  });
}

/**
 * Execution failure: the step failed. The card may move to a recovery step
 * (the step's error return), but the run itself stays a failure — a routed
 * recovery is not a successful outcome.
 */
async function endRunFailed(
  bus: Bus,
  task: RunTask,
  pipeline: Pipeline,
  step: PipelineStep,
  error: string,
  returnTo: string | undefined,
): Promise<void> {
  if (returnTo !== undefined) {
    await bus.publish(task.projectId, 'cardStepMoved', {
      cardId: task.cardId,
      pipelineId: pipeline.id,
      fromStepId: step.id,
      toStepId: returnTo,
    });
  }
  await bus.publish(task.projectId, 'pipelineRunEnded', {
    runId: task.runId,
    cardId: task.cardId,
    pipelineId: pipeline.id,
    revision: pipeline.revision,
    status: 'failed',
    ...(error !== '' ? { error } : {}),
    ...(returnTo !== undefined ? { routedToStepId: returnTo } : {}),
  });
}

function prepareGate(task: RunTask): Promise<{ ok: true; decision: GateDecision } | { ok: false; error: string }> {
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