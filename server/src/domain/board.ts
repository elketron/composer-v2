// The board — a project's aggregate of linked objects. The fold's
// ProjectState holds the maps; the Board is the object that answers the
// cross-object questions in one place: which pipeline a card is assigned
// to, which run is active on a card, which pipeline revision a run pinned,
// whether a card is done or blocked, a card's latest run. The processor,
// the runner, the snapshot, and the view shaping all read these rules from
// here instead of re-deriving them from the maps.

import type { ProjectState } from '../fold/index.js';
import { DEFAULT_PIPELINE_ID } from '../pipelines.js';
import type { Assignee, StageOutcomeRule } from '../wire/models.js';
import { CommandRejection, event, type PendingEvent } from './rejection.js';
import { isBlockedIn, Card } from './card.js';
import type { Pipeline } from './pipeline.js';
import type { Run } from './run.js';

export class Board {
  private constructor(private readonly project: ProjectState) {}

  static of(project: ProjectState): Board {
    return new Board(project);
  }

  card(id: string): Card | undefined {
    return this.project.cards.get(id);
  }

  get cards(): ReadonlyMap<string, Card> {
    return this.project.cards;
  }

  pipeline(id: string): Pipeline | undefined {
    return this.project.pipelines.get(id);
  }

  /** The pipeline a card is assigned to (the card's stage is one of its stages). */
  pipelineOf(card: Pick<Card, 'pipelineId'>): Pipeline | undefined {
    return this.project.pipelines.get(card.pipelineId);
  }

  run(id: string): Run | undefined {
    return this.project.runs.get(id);
  }

  get runs(): ReadonlyMap<string, Run> {
    return this.project.runs;
  }

  /** The card's active run, if any (at most one). */
  activeRun(cardId: string): Run | undefined {
    const runId = this.project.activeRuns.get(cardId);
    return runId !== undefined ? this.project.runs.get(runId) : undefined;
  }

  /**
   * The pipeline revision a run pinned — an edited pipeline never changes a
   * live or historical run's rules. A revision the fold no longer holds (or
   * an unnumbered run) falls back to the pipeline's current definition.
   */
  pipelineOfRun(run: Pick<Run, 'pipelineId' | 'revision'>): Pipeline | undefined {
    return (
      this.project.pipelineRevisions.get(run.pipelineId)?.get(run.revision) ??
      this.project.pipelines.get(run.pipelineId)
    );
  }

  /** Whether a card sits in its pipeline's terminal (completion) stage. */
  isDone(card: Pick<Card, 'pipelineId' | 'stageId'>): boolean {
    return this.pipelineOf(card)?.isTerminalStage(card.stageId) === true;
  }

  /** Blocked while any blocker exists and has not reached its own pipeline's terminal stage. */
  isBlocked(card: Pick<Card, 'blockedBy'>): boolean {
    return isBlockedIn(this.project.cards, card, this.project.pipelines);
  }

  /** The card's most recent run by start time (any status), if one exists. */
  latestRunOf(cardId: string): Run | undefined {
    let latest: Run | undefined;
    for (const run of this.project.runs.values()) {
      if (run.cardId !== cardId) continue;
      if (latest === undefined || run.startedAt >= latest.startedAt) latest = run;
    }
    return latest;
  }

  /** The project's default pipeline: PL-1 when present, else the first by id. */
  defaultPipeline(): Pipeline | undefined {
    const pipelines = this.project.pipelines;
    if (pipelines.size === 0) return undefined;
    if (pipelines.has(DEFAULT_PIPELINE_ID)) return pipelines.get(DEFAULT_PIPELINE_ID);
    return pipelines.get([...pipelines.keys()].sort()[0]!);
  }

  // ---- Card transitions ----
  // Each answers a command with the canonical events to publish, or throws
  // a CommandRejection (same codes and messages the processor emitted when
  // the validation lived there).

  /** The named card, or a rejection. */
  requireCard(cardId: string): Card {
    const card = this.project.cards.get(cardId);
    if (card === undefined) throw new CommandRejection('unknownCard', `Unknown card ${cardId}`);
    return card;
  }

  /** The pipeline a card is assigned to, or a rejection. */
  requirePipelineOf(card: Pick<Card, 'id' | 'pipelineId'>): Pipeline {
    const pipeline = this.pipelineOf(card);
    if (pipeline === undefined) throw new CommandRejection('unknownPipeline', `Card ${card.id} has no assigned pipeline`);
    return pipeline;
  }

  /** The card's active run, or a rejection (distinguishing an unknown card). */
  requireActiveRun(cardId: string): Run {
    const run = this.activeRun(cardId);
    if (run === undefined) {
      const unknown = this.project.cards.get(cardId) === undefined;
      throw new CommandRejection(
        unknown ? 'unknownCard' : 'pipelineNotRunning',
        unknown ? `Unknown card ${cardId}` : `Card ${cardId} has no running pipeline`,
      );
    }
    return run;
  }

  /**
   * Moves a card to a stage of its assigned pipeline: the target must be a
   * stage of the card's pipeline, the move needs no active run, the same
   * stage is a no-op (an empty event list), and unsatisfied blockers reject
   * unless overridden. Dependents whose blocked-ness flips get a
   * dependencyStateChanged.
   */
  moveCard(cardId: string, toStageId: string, override: boolean, comment: string | undefined): PendingEvent[] {
    const card = this.requireCard(cardId);
    const pipeline = this.requirePipelineOf(card);
    if (pipeline.stageById(toStageId) === undefined) {
      throw new CommandRejection('unknownStage', `Stage '${toStageId}' is not a stage of pipeline ${pipeline.id}`);
    }
    if (this.activeRun(cardId) !== undefined) {
      throw new CommandRejection('runActive', `Card ${cardId} has an active pipeline run`);
    }
    if (card.stageId === toStageId) return [];
    if (!override && this.isBlocked(card)) {
      throw new CommandRejection('blocked', `Card ${cardId} has unsatisfied blockers`);
    }
    const moved = card.with({ stageId: toStageId });
    return [
      event('cardStageMoved', {
        cardId: card.id,
        pipelineId: pipeline.id,
        fromStageId: card.stageId,
        toStageId,
        ...(comment !== undefined ? { comment } : {}),
      }),
      ...this.dependencyEvents(moved),
    ];
  }

  /**
   * Assigns a card to a pipeline (it appears on that pipeline's board tab).
   * The assignment always places the card in the pipeline's first stage;
   * assigning a completed card reopens it. Needs no active run.
   */
  assignPipeline(cardId: string, pipelineId: string): PendingEvent[] {
    const card = this.requireCard(cardId);
    const pipeline = this.pipeline(pipelineId);
    if (pipeline === undefined) throw new CommandRejection('unknownPipeline', `Unknown pipeline ${pipelineId}`);
    if (this.activeRun(cardId) !== undefined) {
      throw new CommandRejection('runActive', `Card ${cardId} has an active pipeline run`);
    }
    return [
      event('cardPipelineAssigned', {
        cardId: card.id,
        pipelineId: pipeline.id,
        stageId: pipeline.firstStage().id,
      }),
    ];
  }

  /** Reopens a completed card: it returns to its pipeline's first stage. */
  reopenCard(cardId: string): PendingEvent[] {
    const card = this.requireCard(cardId);
    const pipeline = this.requirePipelineOf(card);
    if (!pipeline.isTerminalStage(card.stageId)) {
      throw new CommandRejection('invalidCommand', `Card ${cardId} is not completed`);
    }
    if (this.activeRun(cardId) !== undefined) {
      throw new CommandRejection('runActive', `Card ${cardId} has an active pipeline run`);
    }
    return [
      event('cardStageMoved', {
        cardId: card.id,
        pipelineId: pipeline.id,
        fromStageId: card.stageId,
        toStageId: pipeline.firstStage().id,
      }),
    ];
  }

  /** Updates one step's execution state; the card must be idle. */
  updateStepState(cardId: string, stepId: string, status: 'pending' | 'running' | 'ok' | 'failed'): PendingEvent[] {
    const card = this.requireCard(cardId);
    const pipeline = this.pipelineOf(card);
    if (pipeline === undefined || pipeline.stepById(stepId) === undefined) {
      throw new CommandRejection('unknownStage', `Step '${stepId}' is not a step of the card's pipeline`);
    }
    if (this.activeRun(cardId) !== undefined) {
      throw new CommandRejection('runActive', `Card ${cardId} has an active pipeline run`);
    }
    return [event('cardStepStateUpdated', { cardId: card.id, stepId, status })];
  }

  /** Toggles a stage's automation (human drags are never blocked by them). */
  toggleAutomation(pipelineId: string, stageId: string, on: boolean): PendingEvent[] {
    const pipeline = this.pipeline(pipelineId);
    if (pipeline === undefined) throw new CommandRejection('unknownPipeline', `Unknown pipeline ${pipelineId}`);
    if (pipeline.stageById(stageId) === undefined) {
      throw new CommandRejection('unknownStage', `Stage '${stageId}' is not a stage of pipeline ${pipelineId}`);
    }
    return [event('automationToggled', { pipelineId, stageId, on })];
  }

  /** Changes a card's type (v1 `change_card_type`); the fold resets step states. Same type is a no-op. */
  changeType(cardId: string, toType: 'coding' | 'design' | 'docs'): PendingEvent[] {
    const card = this.requireCard(cardId);
    if (card.type === toType) return [];
    return [event('cardTypeChanged', { cardId: card.id, from: card.type, to: toType })];
  }

  /** Assigns (or unassigns) a card; the assignee rides the event (v1 §3.4). */
  assign(cardId: string, assignee: Assignee | undefined): PendingEvent[] {
    const card = this.requireCard(cardId);
    return [event('cardAssigned', { cardId: card.id, ...(assignee ? { assignee } : {}) })];
  }

  /** Archives a card (v1 `archive_card`); dependents re-derive blocking. */
  archive(cardId: string): PendingEvent[] {
    const card = this.requireCard(cardId);
    return [event('cardArchived', { cardId: card.id })];
  }

  /** The card and pipeline a run command starts from (existence and assignment). */
  requireRunnableCard(cardId: string): { card: Card; pipeline: Pipeline } {
    const card = this.requireCard(cardId);
    const pipeline = this.requirePipelineOf(card);
    return { card, pipeline };
  }

  /** The run-start preconditions that follow the directory check: an idle card, not completed. */
  requireStartable(cardId: string, pipeline: Pipeline): void {
    if (this.activeRun(cardId) !== undefined) {
      throw new CommandRejection('runActive', `Card ${cardId} already has a running pipeline`);
    }
    if (pipeline.isTerminalStage(this.requireCard(cardId).stageId)) {
      throw new CommandRejection('invalidCommand', `Card ${cardId} is completed — reopen it to run again`);
    }
  }

  /** The run a stop command cancels. */
  requireStoppable(cardId: string): Run {
    return this.requireActiveRun(cardId);
  }

  /** The run a gate answer resolves; it must be parked waiting at the gate. */
  requireGateWait(cardId: string): Run {
    const run = this.requireActiveRun(cardId);
    if (run.status !== 'waiting') {
      throw new CommandRejection('pipelineNotRunning', `Card ${cardId}'s pipeline is not waiting at a gate`);
    }
    return run;
  }

  /** The run an agent outcome reports into: live, at an agent step. */
  requireAgentStepRun(cardId: string): Run {
    const run = this.requireActiveRun(cardId);
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
    const pipeline = this.pipelineOfRun(run);
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
    const pipeline = this.pipelineOfRun(run);
    return rule.toStageId !== undefined
      ? `the card returns to ${pipeline?.stageById(rule.toStageId)?.label ?? rule.toStageId} when the step finishes`
      : 'the pipeline proceeds when the step finishes';
  }

  /**
   * After a move, the moved card's dependents whose blocked-ness flipped
   * (v1 `append_dependency_transitions`), computed against the board's
   * pre-move state.
   */
  private dependencyEvents(moved: Card): PendingEvent[] {
    const after = new Map(this.project.cards);
    after.set(moved.id, moved);
    const events: PendingEvent[] = [];
    for (const dependent of this.project.cards.values()) {
      if (!dependent.blockedBy.includes(moved.id)) continue;
      const was = isBlockedIn(this.project.cards, dependent, this.project.pipelines);
      const now = isBlockedIn(after, dependent, this.project.pipelines);
      if (was !== now) {
        events.push(
          event('dependencyStateChanged', {
            cardId: dependent.id,
            blocked: now,
            blockedBy: [...dependent.blockedBy],
          }),
        );
      }
    }
    return events;
  }
}
