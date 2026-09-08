// Drives one pinned pipeline run through its steps and applies completion
// and recovery transitions.

import type { Bus } from '../bus.js';
import type { AgentEngine } from '../engine/types.js';
import type { Pipeline, PipelineStage } from '../wire/models.js';
import { runAgentStep } from './agent-step.js';
import { runCommandStep } from './command-step.js';
import { outcomeBriefOf, stageOrderOf } from './prompts.js';
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
  // A returned card reruns from its current stage; earlier steps are skipped.
  const fromOrder = stageOrderOf(pipeline, card.stageId);
  const steps = pipeline.steps.filter(
    (step) => stageOrderOf(pipeline, step.stageId) >= fromOrder,
  );

  for (const step of steps) {
    if (task.stopped) return;
    const stage = pipeline.stages.find((candidate) => candidate.id === step.stageId)!;

    // Arm the gate before publishing the waiting transition so an immediate
    // response always finds its resolver.
    const gatePromise = step.kind === 'human' ? prepareGate(task) : null;
    await bus.publish(projectId, 'pipelineStepStarted', {
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
        ? await runCommandStep(bus, task, step, options.commandTimeoutMs)
        : step.kind === 'agent'
          ? await runAgentStep(bus, engine, options, task, step, outcomeBriefOf(pipeline, stage))
          : await gatePromise!;

    if (task.stopped) return;
    let failure: string | undefined = result.ok ? undefined : result.error;
    let returnTo: { target: string; report: OutcomeReport } | undefined;
    if (result.ok && step.kind === 'agent') {
      const reported = result.outcome;
      const rule = reported !== undefined
        ? (stage.outcomes ?? []).find((candidate) => candidate.outcome === reported.outcome)
        : undefined;
      if (reported !== undefined && rule?.toStageId !== undefined) {
        returnTo = { target: rule.toStageId, report: reported };
      } else if (reported === undefined && (stage.outcomes?.length ?? 0) > 0 && stage.requiresOutcome === true) {
        const names = (stage.outcomes ?? []).map((candidate) => candidate.outcome).join(', ');
        failure = `the stage requires an explicit outcome — call composer_report_outcome with one of: ${names}`;
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
      await endRun(bus, task, pipeline, stage, 'failed', failure);
      return;
    }
    if (returnTo !== undefined) {
      const note = returnTo.report.note?.trim();
      await endRun(
        bus,
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
        await endRun(
          bus,
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

  await bus.publish(projectId, 'pipelineRunEnded', {
    runId,
    cardId,
    pipelineId: pipeline.id,
    revision: pipeline.revision,
    status: 'completed',
  });
  const terminal = pipeline.stages.at(-1);
  if (terminal !== undefined) {
    await bus.publish(projectId, 'cardStageMoved', {
      cardId,
      pipelineId: pipeline.id,
      toStageId: terminal.id,
    });
  }
}

async function endRun(
  bus: Bus,
  task: RunTask,
  pipeline: Pipeline,
  stage: PipelineStage,
  status: 'failed' | 'returned',
  error: string,
  comment?: string,
  returnTo: string | undefined = stage.errorReturnToStageId,
): Promise<void> {
  if (returnTo !== undefined) {
    await bus.publish(task.projectId, 'cardStageMoved', {
      cardId: task.cardId,
      pipelineId: pipeline.id,
      fromStageId: stage.id,
      toStageId: returnTo,
      ...(comment !== undefined ? { comment } : {}),
    });
  }
  await bus.publish(task.projectId, 'pipelineRunEnded', {
    runId: task.runId,
    cardId: task.cardId,
    pipelineId: pipeline.id,
    revision: pipeline.revision,
    status: returnTo !== undefined ? 'returned' : status,
    ...(error !== '' ? { error } : {}),
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
