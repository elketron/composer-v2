// The card commands: creation (single or bulk, with in-batch blocker
// checks), and the board-delegated transitions — the validation lives on
// the domain objects (R3); each handler answers the board, publishes the
// events, and maps a typed rejection onto the wire outcome.

import type { CommandOutcome } from '../wire/commands.js';
import { nowIso } from '../wire/envelope.js';
import type { Assignee, Card as CardJson, CardType, SubStateStatus } from '../wire/models.js';
import { Card, isBlockedIn } from '../domain/card.js';
import { Board } from '../domain/board.js';
import { isSet } from './cards-util.js';
import { command, isOutcome, ok, rejected, toRejection, allocateId, type CommandMap } from './helpers.js';
import { transition } from './transition.js';
import type { Processor } from './index.js';

  /**
   * Creates one or more cards (v1 `create_cards`): the scope must exist and
   * every `blockedBy` must reference a card that exists at command time
   * (in-batch cross-references are planner-ticket territory, not this).
   * Every card is assigned to a pipeline — the requested one, else the
   * project's default — and begins in that pipeline's first stage.
   * Events publish per card, so each allocation sees the previous one.
   */

export async function createCards(p: Processor, scope: string | undefined, cards: CardJson[]): Promise<CommandOutcome> {
    if (scope === undefined || !p.bus.state.projects.has(scope)) {
      return rejected('unknownProject', `Unknown project ${scope ?? ''}`);
    }
    if (cards.length === 0) {
      return rejected('invalidCommand', 'No cards to create');
    }
    const existing = p.cardsOf(scope);
    for (const card of cards) {
      if (card.blockedBy.some((id) => !existing.has(id))) {
        return rejected('invalidCommand', `blockedBy of '${card.title}' references unknown cards`);
      }
    }

    const now = nowIso();
    for (const card of cards) {
      const pipeline =
        card.pipelineId !== ''
          ? p.pipelinesOf(scope).get(card.pipelineId)
          : p.defaultPipelineOf(scope);
      if (pipeline === undefined) {
        return rejected(
          card.pipelineId !== '' ? 'unknownPipeline' : 'invalidCommand',
          card.pipelineId !== ''
            ? `Unknown pipeline ${card.pipelineId}`
            : `Project ${scope} has no pipeline to assign the card to`,
        );
      }
      const created = new Card({
        ...card,
        id: card.id !== '' ? card.id : allocateCardId(p, scope),
        projectId: scope,
        pipelineId: pipeline.id,
        stageId: pipeline.firstStage().id,
        stepStates: card.stepStates ?? {},
        createdAt: isSet(card.createdAt) ? card.createdAt : now,
        updatedAt: now,
      });
      existing.set(created.id, created);
      await p.bus.publish(scope, 'cardCreated', { card: created });
      if (isBlockedIn(existing, created, p.pipelinesOf(scope))) {
        await p.bus.publish(scope, 'dependencyStateChanged', {
          cardId: created.id,
          blocked: true,
          blockedBy: created.blockedBy,
        });
      }
    }
    return ok();
  }

export function allocateCardId(p: Processor, projectId: string): string {
  return allocateId(p.cardsOf(projectId).keys(), 'T');
}

  /** The board a scoped card command answers from, or the unknown-card rejection. */


  /** The board a scoped card command answers from, or the unknown-card rejection. */

export function cardBoard(p: Processor, scope: string | undefined, cardId: string): Board | CommandOutcome {
    const board = p.boardOf(scope ?? '');
    if (scope === undefined || board === undefined) {
      return rejected('unknownCard', `Unknown card ${cardId}`);
    }
    return board;
  }

  /**
   * Runs a card transition: the board answers with its events (or a typed
   * rejection), and the events publish in order under the write lock.
   */


  /**
   * Moves a card to a stage of its assigned pipeline: the move needs no
   * active run (the pipeline owns transitions while one runs), the target
   * must be a stage of the card's pipeline, the same stage is a no-op, and
   * unsatisfied blockers reject unless overridden. Dependents whose
   * blocked-ness flips get a dependencyStateChanged.
   */

export async function moveCardStage(
    p: Processor,
    scope: string | undefined,
    cardId: string,
    toStageId: string,
    override: boolean,
    comment: string | undefined,
  ): Promise<CommandOutcome> {
    const board = cardBoard(p, scope, cardId);
    if (isOutcome(board)) return board;
    return transition(p.bus, scope!, () => board.moveCard(cardId, toStageId, override, comment));
  }

  /**
   * Assigns a card to a pipeline (it appears on that pipeline's board tab).
   * The assignment always places the card in the pipeline's first stage;
   * assigning a completed card reopens it. Needs no active run.
   */


  /**
   * Assigns a card to a pipeline (it appears on that pipeline's board tab).
   * The assignment always places the card in the pipeline's first stage;
   * assigning a completed card reopens it. Needs no active run.
   */

export async function assignCardPipeline(
    p: Processor,
    scope: string | undefined,
    cardId: string,
    pipelineId: string,
  ): Promise<CommandOutcome> {
    const board = cardBoard(p, scope, cardId);
    if (isOutcome(board)) return board;
    return transition(p.bus, scope!, () => board.assignPipeline(cardId, pipelineId));
  }

  /** Reopens a completed card: it returns to its pipeline's first stage. */


  /** Reopens a completed card: it returns to its pipeline's first stage. */

export async function reopenCard(p: Processor, scope: string | undefined, cardId: string): Promise<CommandOutcome> {
    const board = cardBoard(p, scope, cardId);
    if (isOutcome(board)) return board;
    return transition(p.bus, scope!, () => board.reopenCard(cardId));
  }

  /** Changes a card's type (v1 `change_card_type`); the fold resets step states. */


  /** Changes a card's type (v1 `change_card_type`); the fold resets step states. */

export async function changeCardType(
    p: Processor,
    scope: string | undefined,
    cardId: string,
    toType: CardType,
  ): Promise<CommandOutcome> {
    const board = cardBoard(p, scope, cardId);
    if (isOutcome(board)) return board;
    return transition(p.bus, scope!, () => board.changeType(cardId, toType));
  }

  /** Assigns (or unassigns) a card; the assignee rides the event (v1 §3.4). */


  /** Assigns (or unassigns) a card; the assignee rides the event (v1 §3.4). */

export async function assignCard(
    p: Processor,
    scope: string | undefined,
    cardId: string,
    assignee: Assignee | undefined,
  ): Promise<CommandOutcome> {
    const board = cardBoard(p, scope, cardId);
    if (isOutcome(board)) return board;
    return transition(p.bus, scope!, () => board.assign(cardId, assignee));
  }

  /** Archives a card (v1 `archive_card`); dependents re-derive blocking. */


  /** Archives a card (v1 `archive_card`); dependents re-derive blocking. */

export async function archiveCard(p: Processor, scope: string | undefined, cardId: string): Promise<CommandOutcome> {
    const board = cardBoard(p, scope, cardId);
    if (isOutcome(board)) return board;
    return transition(p.bus, scope!, () => board.archive(cardId));
  }

  /** Updates one step's execution state; the card must be idle. */


  /** Updates one step's execution state; the card must be idle. */

export async function updateStepState(
    p: Processor,
    scope: string | undefined,
    cardId: string,
    stepId: string,
    status: SubStateStatus,
  ): Promise<CommandOutcome> {
    const board = cardBoard(p, scope, cardId);
    if (isOutcome(board)) return board;
    return transition(p.bus, scope!, () => board.updateStepState(cardId, stepId, status));
  }

  /** Toggles a stage's automation (v1 `toggle_automation`), per pipeline stage. */


  /** Toggles a stage's automation (v1 `toggle_automation`), per pipeline stage. */

export async function toggleAutomation(
    p: Processor,
    scope: string | undefined,
    pipelineId: string,
    stageId: string,
    on: boolean,
  ): Promise<CommandOutcome> {
    if (scope === undefined || !p.bus.state.projects.has(scope)) {
      return rejected('unknownProject', `Unknown project ${scope ?? ''}`);
    }
    const board = p.boardOf(scope);
    if (board === undefined) {
      return rejected('unknownProject', `Unknown project ${scope}`);
    }
    return transition(p.bus, scope, () => board.toggleAutomation(pipelineId, stageId, on));
  }

  // ---- Planning ----

  /** Opens a planning session (v1 `create_session`); the command names the project. */


export const cardCommands: CommandMap = [
  command('requestCardCreate', (p, scope, cmd) => createCards(p, scope, [cmd.card])),
  command('requestCardsCreate', (p, scope, cmd) => createCards(p, scope, cmd.cards)),
  command('requestCardStageMove', (p, scope, cmd) => moveCardStage(p, scope, cmd.cardId, cmd.toStageId, cmd.override, cmd.comment)),
  command('requestCardPipelineAssign', (p, scope, cmd) => assignCardPipeline(p, scope, cmd.cardId, cmd.pipelineId)),
  command('requestCardReopen', (p, scope, cmd) => reopenCard(p, scope, cmd.cardId)),
  command('requestCardTypeChange', (p, scope, cmd) => changeCardType(p, scope, cmd.cardId, cmd.toType)),
  command('requestCardAssign', (p, scope, cmd) => assignCard(p, scope, cmd.cardId, cmd.assignee)),
  command('requestCardArchive', (p, scope, cmd) => archiveCard(p, scope, cmd.cardId)),
  command('requestStepStateUpdate', (p, scope, cmd) => updateStepState(p, scope, cmd.cardId, cmd.stepId, cmd.status)),
  command('requestAutomationToggle', (p, scope, cmd) => toggleAutomation(p, scope, cmd.pipelineId, cmd.stageId, cmd.on)),
];
