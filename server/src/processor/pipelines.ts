// The pipeline and run commands: save (the definition validates on the
// Pipeline object; the id/revision allocation stays here), delete, and the
// run lifecycle — start, stop, gate answers, and the agent outcome report
// (S36) whose rules the run's pinned revision owns.

import { Pipeline } from '../domain/pipeline.js';
import { Board } from '../domain/board.js';
import type { Run } from '../domain/run.js';
import { nowIso } from '../wire/envelope.js';
import type { CommandOutcome } from '../wire/commands.js';
import type { Pipeline as PipelineJson, PipelineStage as PipelineStageJson } from '../wire/models.js';
import { PIPELINE_AGENT_KINDS } from '../agents/index.js';
import { command, allocateId, ok, rejected, toRejection, type CommandMap } from './helpers.js';
import type { Processor } from './index.js';

  /**
   * Saves a user-authored pipeline: an empty id allocates the next `PL-N`,
   * a known id upserts. The definition is validated in full (stages, the
   * forward path, terminal stage); a save that changes nothing is a no-op,
   * a changed save allocates the next revision — active and historical runs
   * keep the revision they started on.
   */

export async function savePipeline(p: Processor, scope: string | undefined, pipeline: PipelineJson): Promise<CommandOutcome> {
    if (scope === undefined || !p.bus.state.projects.has(scope)) {
      return rejected('unknownProject', `Unknown project ${scope ?? ''}`);
    }
    let stages: PipelineStageJson[];
    try {
      stages = Pipeline.validateDraft(pipeline);
    } catch (error) {
      return toRejection(error);
    }
    const name = pipeline.name.trim();
    const id = pipeline.id.trim() !== '' ? pipeline.id.trim() : allocateId(p.pipelinesOf(scope).keys(), 'PL');
    const current = p.pipelinesOf(scope).get(id);
    if (current !== undefined && Pipeline.sameDefinition(current, pipeline, name)) {
      return ok();
    }
    const saved: PipelineJson = {
      id,
      projectId: scope,
      name,
      revision: (current?.revision ?? 0) + 1,
      stages,
      steps: pipeline.steps,
      updatedAt: nowIso(),
    };
    await p.bus.publish(scope, 'pipelineSaved', { pipeline: saved });
    return ok();
  }

  /**
   * Deletes a user-authored pipeline (v1 `delete_pipeline`): the tombstone
   * keeps the boot seed from resurrecting the default. A pipeline with
   * assigned cards rejects — reassign them first.
   */


  /**
   * Deletes a user-authored pipeline (v1 `delete_pipeline`): the tombstone
   * keeps the boot seed from resurrecting the default. A pipeline with
   * assigned cards rejects — reassign them first.
   */

export async function deletePipeline(p: Processor, scope: string | undefined, pipelineId: string): Promise<CommandOutcome> {
    if (scope === undefined || !p.pipelinesOf(scope).has(pipelineId)) {
      return rejected('unknownPipeline', `Unknown pipeline ${pipelineId}`);
    }
    const assigned = [...p.cardsOf(scope).values()].filter((card) => card.pipelineId === pipelineId);
    if (assigned.length > 0) {
      return rejected(
        'invalidCommand',
        `Pipeline ${pipelineId} still has ${assigned.length} assigned card${assigned.length === 1 ? '' : 's'}`,
      );
    }
    await p.bus.publish(scope, 'pipelineDeleted', { pipelineId });
    return ok();
  }

  /**
   * Runs a card's assigned pipeline: the validated run event allocates the
   * run (pinned to the pipeline's current revision) and is the runner's
   * trigger. The run executes from the card's current stage onward.
   */


  /**
   * Runs a card's assigned pipeline: the validated run event allocates the
   * run (pinned to the pipeline's current revision) and is the runner's
   * trigger. The run executes from the card's current stage onward.
   */

export async function runPipeline(p: Processor, scope: string | undefined, cardId: string): Promise<CommandOutcome> {
    if (scope === undefined || !p.bus.state.projects.has(scope)) {
      return rejected('unknownProject', `Unknown project ${scope ?? ''}`);
    }
    const board = p.boardOf(scope);
    if (board === undefined) {
      return rejected('unknownCard', `Unknown card ${cardId}`);
    }
    let pipeline: Pipeline;
    try {
      ({ pipeline } = board.requireRunnableCard(cardId));
    } catch (error) {
      return toRejection(error);
    }
    if (p.bus.state.projects.get(scope)?.directory === undefined) {
      return rejected('invalidCommand', `Project ${scope} has no directory set`);
    }
    try {
      board.requireStartable(cardId, pipeline);
    } catch (error) {
      return toRejection(error);
    }
    const kind = pipeline.steps.find((step) => step.kind === 'agent')?.agentKind;
    if (kind !== undefined && !PIPELINE_AGENT_KINDS.includes(kind)) {
      return rejected('unknownAgentKind', `Agent kind '${kind}' has no implementation yet`);
    }

    const runId = allocateId(p.runsOf(scope).keys(), 'R');
    await p.bus.publish(scope, 'pipelineRunStarted', {
      runId,
      cardId,
      pipelineId: pipeline.id,
      revision: pipeline.revision,
    });
    return { ok: true, runId };
  }

  /**
   * Stops a card's active run: the event is the canonical record and the
   * runner's kill trigger.
   */


  /**
   * Stops a card's active run: the event is the canonical record and the
   * runner's kill trigger.
   */

export async function stopPipeline(p: Processor, scope: string | undefined, cardId: string): Promise<CommandOutcome> {
    if (scope === undefined) {
      return unknownCardOrNotRunning(p, scope, cardId);
    }
    const board = p.boardOf(scope);
    if (board === undefined) {
      return rejected('unknownCard', `Unknown card ${cardId}`);
    }
    let run: Run;
    try {
      run = board.requireStoppable(cardId);
    } catch (error) {
      return toRejection(error);
    }
    await p.bus.publish(scope, 'pipelineRunEnded', {
      runId: run.id,
      cardId,
      pipelineId: run.pipelineId,
      revision: run.revision,
      status: 'cancelled',
    });
    return ok();
  }

  /**
   * Answers a parked approval gate (v1 `gate_respond`): the run must be
   * waiting at a `human` step; the runner wakes with the decision.
   */


  /**
   * Answers a parked approval gate (v1 `gate_respond`): the run must be
   * waiting at a `human` step; the runner wakes with the decision.
   */

export async function gateRespond(
    p: Processor,
    scope: string | undefined,
    cardId: string,
    approved: boolean,
    comment: string | undefined,
  ): Promise<CommandOutcome> {
    if (scope === undefined) {
      return unknownCardOrNotRunning(p, scope, cardId);
    }
    const board = p.boardOf(scope);
    if (board === undefined) {
      return rejected('unknownCard', `Unknown card ${cardId}`);
    }
    let run: Run;
    try {
      run = board.requireGateWait(cardId);
    } catch (error) {
      return toRejection(error);
    }
    await p.bus.publish(scope, 'pipelineGateResponded', {
      runId: run.id,
      cardId,
      approved,
      ...(comment !== undefined ? { comment } : {}),
    });
    return ok();
  }

  /** The stop/gate rejection when the scope names no card at all. */


  /** The stop/gate rejection when the scope names no card at all. */

export function unknownCardOrNotRunning(p: Processor, scope: string | undefined, cardId: string): CommandOutcome {
    const unknown = p.boardOf(scope ?? '')?.card(cardId) === undefined;
    return rejected(
      unknown ? 'unknownCard' : 'pipelineNotRunning',
      unknown ? `Unknown card ${cardId}` : `Card ${cardId} has no running pipeline`,
    );
  }

  /**
   * The outcome tool's validated path (S36): a running agent session
   * signals its stage outcome. The run must be live at an agent step
   * whose stage — on the run's pinned revision — defines the named
   * outcome. The event is the decision record; the runner applies the
   * transition (proceed, or return the card to the rule's stage).
   */


  /**
   * The outcome tool's validated path (S36): a running agent session
   * signals its stage outcome. The run must be live at an agent step
   * whose stage — on the run's pinned revision — defines the named
   * outcome. The event is the decision record; the runner applies the
   * transition (proceed, or return the card to the rule's stage).
   */

export async function reportOutcome(
    p: Processor,
    scope: string | undefined,
    sessionId: string,
    outcome: string,
    note: string | undefined,
  ): Promise<CommandOutcome> {
    if (scope === undefined || !p.bus.state.projects.has(scope)) {
      return rejected('unknownProject', `Unknown project ${scope ?? ''}`);
    }
    const board = p.boardOf(scope);
    const session = p.bus.state.byProject.get(scope)?.agentSessions.get(sessionId);
    if (board === undefined || session === undefined) {
      return rejected('unknownSession', `Unknown session ${sessionId}`);
    }
    if (session.status !== 'running') {
      return rejected('invalidCommand', `Session ${sessionId} is not running`);
    }
    const cardId = session.cardId;
    let run: Run;
    try {
      run = board.requireAgentStepRun(cardId);
      const { rule, name } = board.outcomeRule(run, outcome);
      const trimmedNote = note?.trim();
      await p.bus.publish(scope, 'pipelineOutcomeReported', {
        runId: run.id,
        cardId,
        pipelineId: run.pipelineId,
        stepId: run.stepId!,
        outcome: name,
        ...(trimmedNote !== undefined && trimmedNote !== '' ? { note: trimmedNote } : {}),
      });
      return { ok: true, transition: board.outcomeTransitionText(run, rule) };
    } catch (error) {
      return toRejection(error);
    }
  }

  // ---- Pipeline helpers ----


export const pipelineCommands: CommandMap = [
  command('requestPipelineSave', (p, scope, cmd) => savePipeline(p, scope, cmd.pipeline)),
  command('requestPipelineDelete', (p, scope, cmd) => deletePipeline(p, scope, cmd.pipelineId)),
  command('requestPipelineRun', (p, scope, cmd) => runPipeline(p, scope, cmd.cardId)),
  command('requestPipelineStop', (p, scope, cmd) => stopPipeline(p, scope, cmd.cardId)),
  command('requestPipelineGateRespond', (p, scope, cmd) => gateRespond(p, scope, cmd.cardId, cmd.approved, cmd.comment)),
  command('requestPipelineOutcomeReport', (p, scope, cmd) => reportOutcome(p, scope, cmd.sessionId, cmd.outcome, cmd.note)),
];
