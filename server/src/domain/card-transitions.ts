// The card commands' transitions (SRV-007): the event-producing answers to
// the card commands — move, pipeline assignment, reopen, step state, type
// change, assign, archive, and the automation toggle — split from the
// `Board`, which remains the read facade. Each transition answers with the
// canonical events to publish, or throws a `CommandRejection` (the same
// codes and messages the processor always emitted).

import type { ProjectState } from '../fold/index.js';
import type { Assignee } from '../wire/models.js';
import { CommandRejection, event, type PendingEvent } from './rejection.js';
import { isBlockedIn, type Card } from './card.js';
import { Board } from './board.js';

export class CardTransitions {
  private constructor(
    private readonly board: Board,
    private readonly state: ProjectState,
  ) {}

  static of(state: ProjectState): CardTransitions {
    return new CardTransitions(Board.of(state), state);
  }

  /**
   * Moves a card to a step of its assigned pipeline: the target must be a
   * step of the card's pipeline, the move needs no active run, the same
   * step is a no-op (an empty event list), and unsatisfied blockers reject
   * unless overridden. Dependents whose blocked-ness flips get a
   * dependencyStateChanged.
   */
  moveCard(cardId: string, toLaneId: string, override: boolean, comment: string | undefined): PendingEvent[] {
    const card = this.board.requireCard(cardId);
    const pipeline = this.board.requirePipelineOf(card);
    if (pipeline.laneById(toLaneId) === undefined) {
      throw new CommandRejection('unknownLane', `Lane '${toLaneId}' is not a lane of pipeline ${pipeline.id}`);
    }
    if (this.board.activeRun(cardId) !== undefined) {
      throw new CommandRejection('runActive', `Card ${cardId} has an active pipeline run`);
    }
    if (card.laneId === toLaneId) return [];
    if (!override && this.board.isBlocked(card)) {
      throw new CommandRejection('blocked', `Card ${cardId} has unsatisfied blockers`);
    }
    const moved = card.with({ laneId: toLaneId });
    return [
      event('cardLaneMoved', {
        cardId: card.id,
        pipelineId: pipeline.id,
        fromLaneId: card.laneId,
        toLaneId,
        ...(comment !== undefined ? { comment } : {}),
      }),
      ...this.dependencyEvents(moved),
    ];
  }

  /**
   * Assigns a card to a pipeline (it appears on that pipeline's board tab).
   * The assignment always places the card at the pipeline's first lane;
   * assigning a completed card reopens it. Needs no active run.
   */
  assignPipeline(cardId: string, pipelineId: string): PendingEvent[] {
    const card = this.board.requireCard(cardId);
    const pipeline = this.board.pipeline(pipelineId);
    if (pipeline === undefined) throw new CommandRejection('unknownPipeline', `Unknown pipeline ${pipelineId}`);
    if (this.board.activeRun(cardId) !== undefined) {
      throw new CommandRejection('runActive', `Card ${cardId} has an active pipeline run`);
    }
    return [
      event('cardPipelineAssigned', {
        cardId: card.id,
        pipelineId: pipeline.id,
        laneId: pipeline.firstLaneId(),
      }),
    ];
  }

  /** Reopens a completed card: it returns to its pipeline's first lane. */
  reopenCard(cardId: string): PendingEvent[] {
    const card = this.board.requireCard(cardId);
    const pipeline = this.board.requirePipelineOf(card);
    if (!pipeline.isTerminalLane(card.laneId)) {
      throw new CommandRejection('invalidCommand', `Card ${cardId} is not completed`);
    }
    if (this.board.activeRun(cardId) !== undefined) {
      throw new CommandRejection('runActive', `Card ${cardId} has an active pipeline run`);
    }
    return [
      event('cardLaneMoved', {
        cardId: card.id,
        pipelineId: pipeline.id,
        fromLaneId: card.laneId,
        toLaneId: pipeline.firstLaneId(),
      }),
    ];
  }

  /** Updates one step's execution state; the card must be idle. */
  updateStepState(cardId: string, stepId: string, status: 'pending' | 'running' | 'ok' | 'failed'): PendingEvent[] {
    const card = this.board.requireCard(cardId);
    const pipeline = this.board.pipelineOf(card);
    if (pipeline === undefined || pipeline.stepById(stepId) === undefined) {
      throw new CommandRejection('unknownStep', `Step '${stepId}' is not a step of the card's pipeline`);
    }
    if (this.board.activeRun(cardId) !== undefined) {
      throw new CommandRejection('runActive', `Card ${cardId} has an active pipeline run`);
    }
    return [event('cardStepStateUpdated', { cardId: card.id, stepId, status })];
  }

  /** Toggles a lane's automation (human drags are never blocked by them). */
  toggleAutomation(pipelineId: string, laneId: string, on: boolean): PendingEvent[] {
    const pipeline = this.board.pipeline(pipelineId);
    if (pipeline === undefined) throw new CommandRejection('unknownPipeline', `Unknown pipeline ${pipelineId}`);
    if (pipeline.laneById(laneId) === undefined) {
      throw new CommandRejection('unknownLane', `Lane '${laneId}' is not a lane of pipeline ${pipelineId}`);
    }
    return [event('automationToggled', { pipelineId, laneId, on })];
  }

  /** Changes a card's type (v1 `change_card_type`); the fold resets step states. Same type is a no-op. */
  changeType(cardId: string, toType: 'coding' | 'design' | 'docs'): PendingEvent[] {
    const card = this.board.requireCard(cardId);
    if (card.type === toType) return [];
    return [event('cardTypeChanged', { cardId: card.id, from: card.type, to: toType })];
  }

  /** Assigns (or unassigns) a card; the assignee rides the event (v1 §3.4). */
  assign(cardId: string, assignee: Assignee | undefined): PendingEvent[] {
    const card = this.board.requireCard(cardId);
    return [event('cardAssigned', { cardId: card.id, ...(assignee ? { assignee } : {}) })];
  }

  /** Archives a card (v1 `archive_card`); dependents re-derive blocking. */
  archive(cardId: string): PendingEvent[] {
    const card = this.board.requireCard(cardId);
    return [event('cardArchived', { cardId: card.id })];
  }

  /**
   * After a move, the moved card's dependents whose blocked-ness flipped
   * (v1 `append_dependency_transitions`), computed against the board's
   * pre-move state.
   */
  private dependencyEvents(moved: Card): PendingEvent[] {
    const after = new Map(this.state.cards);
    after.set(moved.id, moved);
    const events: PendingEvent[] = [];
    for (const dependent of this.state.cards.values()) {
      if (!dependent.blockedBy.includes(moved.id)) continue;
      const was = isBlockedIn(this.state.cards, dependent, this.state.pipelines);
      const now = isBlockedIn(after, dependent, this.state.pipelines);
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