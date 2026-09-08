// The run and outcome policies (SRV-007): the run lifecycle preconditions
// and the gate/outcome rules, split from the `Board` (the read facade). Each
// answers a command with a resolved object or throws a `CommandRejection`.

import type { ProjectState } from '../fold/index.js';
import type { StageOutcomeRule } from '../wire/models.js';
import { CommandRejection } from './rejection.js';
import type { Card } from './card.js';
import type { Pipeline } from './pipeline.js';
import type { Run } from './run.js';
import { Board } from './board.js';

export class RunPolicy {
  private constructor(private readonly board: Board) {}

  static of(state: ProjectState): RunPolicy {
    return new RunPolicy(Board.of(state));
  }

  /** The card and pipeline a run command starts from (existence and assignment). */
  requireRunnableCard(cardId: string): { card: Card; pipeline: Pipeline } {
    const card = this.board.requireCard(cardId);
    const pipeline = this.board.requirePipelineOf(card);
    return { card, pipeline };
  }

  /** The run-start preconditions that follow the directory check: an idle card, not completed. */
  requireStartable(cardId: string, pipeline: Pipeline): void {
    if (this.board.activeRun(cardId) !== undefined) {
      throw new CommandRejection('runActive', `Card ${cardId} already has a running pipeline`);
    }
    if (pipeline.isTerminalStage(this.board.requireCard(cardId).stageId)) {
      throw new CommandRejection('invalidCommand', `Card ${cardId} is completed — reopen it to run again`);
    }
  }

  /** The run a stop command cancels. */
  requireStoppable(cardId: string): Run {
    return this.board.requireActiveRun(cardId);
  }

  /** The run a gate answer resolves; it must be parked waiting at the gate. */
  requireGateWait(cardId: string): Run {
    const run = this.board.requireActiveRun(cardId);
    if (run.status !== 'waiting') {
      throw new CommandRejection('pipelineNotRunning', `Card ${cardId}'s pipeline is not waiting at a gate`);
    }
    return run;
  }

  /** The run an agent outcome reports into: live, at an agent step. */
  requireAgentStepRun(cardId: string): Run {
    const run = this.board.requireActiveRun(cardId);
    if (run.stepKind !== 'agent' || run.stepId === undefined || run.stageId === undefined) {
      throw new CommandRejection('invalidCommand', `Card ${cardId}'s pipeline is not at an agent step`);
    }
    return run;
  }

  /**
   * The named outcome a stage — on the run's pinned revision — defines.
   * An edited pipeline never changes a live run's rules.
   */
  outcomeRule(run: Run, outcome: string): { rule: StageOutcomeRule; name: string } {
    const pipeline = this.board.pipelineOfRun(run);
    const stage = pipeline?.stageById(run.stageId!);
    if (pipeline === undefined || stage === undefined) {
      throw new CommandRejection('unknownPipeline', `Run ${run.id} names an unknown pipeline or stage`);
    }
    const rules = stage.outcomes ?? [];
    const name = outcome.trim();
    const rule = rules.find((candidate) => candidate.outcome === name);
    if (name === '' || rule === undefined) {
      const names = rules.map((candidate) => `'${candidate.outcome}'`).join(', ');
      throw new CommandRejection(
        'invalidCommand',
        names === ''
          ? `Stage ${stage.label} defines no outcomes to report`
          : `outcome '${name}' is not one of stage ${stage.label}'s outcomes: ${names}`,
      );
    }
    return { rule, name };
  }

  /** The human-readable transition an outcome rule drives (the tool result's teaching line). */
  outcomeTransitionText(run: Run, rule: StageOutcomeRule): string {
    const pipeline = this.board.pipelineOfRun(run);
    return rule.toStageId !== undefined
      ? `the card returns to ${pipeline?.stageById(rule.toStageId)?.label ?? rule.toStageId} when the step finishes`
      : 'the pipeline proceeds when the step finishes';
  }
}