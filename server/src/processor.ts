// Command validation → canonical events (v1 architecture.md §Server
// command validation). Same validation order, same rejection messages, and
// the same emitted event lists as v1 for the domains v2 keeps. Human drags
// are never blocked by automation toggles.

import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import type { Bus } from './bus.js';
import type { Command, CommandOutcome, Rejection, TicketEmission } from './wire/commands.js';
import { nowIso } from './wire/envelope.js';import {
  type AssistantThread,
  type Assignee,
  type Card as CardJson,
  type CardProposal,
  type CardType,
  type ChatMessage,
  type Pipeline as PipelineJson,
  type PipelineStage as PipelineStageJson,
  type PlanningSession,
  type ProposalItem,
  type ProposalOutcome,
  type Project,
  type SubStateStatus,
  type WorkflowStep,
} from './wire/models.js';
import { Card, isBlockedIn } from './domain/card.js';
import { Pipeline } from './domain/pipeline.js';
import type { Run } from './domain/run.js';
import { defaultPipeline } from './pipelines.js';
import { Board } from './domain/board.js';
import { Planning } from './domain/planning.js';
import { Proposal, validateProposalItem } from './domain/proposal.js';
import { CommandRejection, type PendingEvent } from './domain/rejection.js';
import { Thread } from './domain/thread.js';
import { PIPELINE_AGENT_KINDS } from './agents/index.js';
import { deleteDoc as deleteDocFile, renameDoc as renameDocFile, saveDoc as saveDocFile } from './docs/index.js';
import { deleteWorkflow as deleteWorkflowFile, saveWorkflow, MAX_WORKFLOW_STEPS } from './workflows.js';
import type { KnowledgeStore } from './knowledge.js';

export class Processor {
  private bus: Bus;
  /** The knowledge library (Phase 9); absent only in narrow unit tests. */
  private readonly knowledge?: KnowledgeStore;

  constructor(bus: Bus, knowledge?: KnowledgeStore) {
    this.bus = bus;
    this.knowledge = knowledge;
  }

  /**
   * Validates a command in the given project scope and, on success,
   * publishes the canonical events (persisted, folded, fanned out) before
   * resolving. S0 handles the project domain; the rest join per slice.
   */
  async execute(projectId: string | undefined, command: Command): Promise<CommandOutcome> {
    if (
      projectId !== undefined &&
      command.type !== 'requestProjectArchive' &&
      command.type !== 'requestProjectRestore' &&
      this.bus.state.projects.get(projectId)?.isArchived
    ) {
      return rejected('invalidCommand', `Project ${projectId} is archived`);
    }

    switch (command.type) {
      case 'requestProjectCreate':
        return this.createProject(command.name, command.directory);
      case 'requestProjectSetDirectory':
        return this.setProjectDirectory(projectId, command.projectId, command.directory);
      case 'requestProjectActivate':
        return this.activateProject(command.projectId);
      case 'requestProjectArchive':
        return this.archiveProject(projectId, command.projectId);
      case 'requestProjectRestore':
        return this.restoreProject(projectId, command.projectId);
      case 'requestCardCreate':
        return this.createCards(projectId, [command.card]);
      case 'requestCardsCreate':
        return this.createCards(projectId, command.cards);
      case 'requestCardStageMove':
        return this.moveCardStage(projectId, command.cardId, command.toStageId, command.override, command.comment);
      case 'requestCardPipelineAssign':
        return this.assignCardPipeline(projectId, command.cardId, command.pipelineId);
      case 'requestCardReopen':
        return this.reopenCard(projectId, command.cardId);
      case 'requestCardTypeChange':
        return this.changeCardType(projectId, command.cardId, command.toType);
      case 'requestCardAssign':
        return this.assignCard(projectId, command.cardId, command.assignee);
      case 'requestCardArchive':
        return this.archiveCard(projectId, command.cardId);
      case 'requestStepStateUpdate':
        return this.updateStepState(projectId, command.cardId, command.stepId, command.status);
      case 'requestAutomationToggle':
        return this.toggleAutomation(projectId, command.pipelineId, command.stageId, command.on);
      case 'requestPlanningSessionCreate':
        return this.createPlanningSession(command.projectId);
      case 'requestUserMessage':
        return this.userMessage(projectId, command.sessionId, command.text);
      case 'requestPlanDocumentUpdate':
        return this.updatePlanDocument(projectId, command.sessionId, command.document);
      case 'requestTicketsCreate':
        return this.createTickets(projectId, command.sessionId, command.tickets);
      case 'requestPipelineSave':
        return this.savePipeline(projectId, command.pipeline);
      case 'requestPipelineDelete':
        return this.deletePipeline(projectId, command.pipelineId);
      case 'requestPipelineRun':
        return this.runPipeline(projectId, command.cardId);
      case 'requestPipelineStop':
        return this.stopPipeline(projectId, command.cardId);
      case 'requestPipelineGateRespond':
        return this.gateRespond(projectId, command.cardId, command.approved, command.comment);
      case 'requestPipelineOutcomeReport':
        return this.reportOutcome(projectId, command.sessionId, command.outcome, command.note);
      case 'requestAssistantThreadCreate':
        return this.createAssistantThread(command.name);
      case 'requestAssistantThreadArchive':
        return this.archiveAssistantThread(command.threadId);
      case 'requestAssistantThreadRestore':
        return this.restoreAssistantThread(command.threadId);
      case 'requestAssistantThreadScope':
        return this.setAssistantThreadScope(command.threadId, command.projectIds);
      case 'requestAssistantMessage':
        return this.assistantMessage(command.threadId, command.text);
      case 'requestAssistantThreadStop':
        return this.stopAssistantThread(command.threadId);
      case 'requestAssistantRetry':
        return this.retryAssistantThread(command.threadId);
      case 'requestAssistantThreadRename':
        return this.renameAssistantThread(command.threadId, command.name);
      case 'requestAssistantResend':
        return this.resendAssistantMessage(command.threadId, command.messageId, command.text);
      case 'requestProposalDraft':
        return this.draftProposal(command.threadId, command.items);
      case 'requestProposalConfirm':
        return this.confirmProposal(command.proposalId, command.items);
      case 'requestProposalDiscard':
        return this.discardProposal(command.proposalId);
      case 'requestDocSave':
        return this.saveDoc(projectId, command.path, command.content);
      case 'requestDocRename':
        return this.renameDoc(projectId, command.path, command.to);
      case 'requestDocDelete':
        return this.deleteDoc(projectId, command.path);
      case 'requestKnowledgeSave':
        return this.saveKnowledge(command);
      case 'requestKnowledgeDelete':
        return this.deleteKnowledge(command.path);
      case 'requestWorkflowRecordStart':
        return this.startWorkflowRecording(projectId, command.sessionId, command.title, command.description, command.tags);
      case 'requestWorkflowRecordStep':
        return this.addWorkflowRecordingStep(projectId, command.sessionId, command.step);
      case 'requestWorkflowRecordStop':
        return this.stopWorkflowRecording(projectId, command.sessionId, command.links);
      case 'requestWorkflowDelete':
        return this.deleteWorkflow(projectId, command.path);
      default: {
        const unknown = command as { type: string };
        return rejected('invalidCommand', `${unknown.type} is not implemented yet`);
      }
    }
  }

  private async createProject(name: string, directory?: string): Promise<CommandOutcome> {
    const trimmed = name.trim();
    if (trimmed === '') {
      return rejected('invalidCommand', 'Project name is required');
    }
    if (
      [...this.bus.state.projects.values()].some(
        (project) => project.name.toLowerCase() === trimmed.toLowerCase(),
      )
    ) {
      return rejected('invalidCommand', `Project '${trimmed}' already exists`);
    }
    const resolved = resolveDirectory(directory);
    if (directory !== undefined && directory.trim() !== '' && resolved === null) {
      return rejected('invalidCommand', 'Project directory must exist');
    }
    if (
      resolved !== null &&
      [...this.bus.state.projects.values()].some((project) =>
        sameDirectory(project.directory, resolved),
      )
    ) {
      return rejected('invalidCommand', `Directory '${resolved}' is already linked`);
    }

    const project: Project = {
      id: allocateId([...this.bus.state.projects.keys()], 'P'),
      name: trimmed,
      ...(resolved !== null ? { directory: resolved } : {}),
      createdAt: new Date().toISOString(),
    };
    await this.bus.publish(project.id, 'projectCreated', { project });
    await this.bus.publish(project.id, 'projectActivated', { projectId: project.id });
    // The default coding pipeline rides the project's creation (deterministic
    // log order; the boot seed only covers logs that predate it).
    await this.bus.publish(project.id, 'pipelineSaved', { pipeline: defaultPipeline(project.id) });
    return ok();
  }

  private async setProjectDirectory(
    scope: string | undefined,
    commandProjectId: string,
    directory: string,
  ): Promise<CommandOutcome> {
    if (scope !== commandProjectId) {
      return rejected('unknownProject', `Unknown project ${scope ?? ''}`);
    }
    const project = this.bus.state.projects.get(commandProjectId);
    if (!project) {
      return rejected('unknownProject', `Unknown project ${commandProjectId}`);
    }
    const resolved = resolveDirectory(directory);
    if (resolved === null) {
      return rejected('invalidCommand', 'Project directory must exist');
    }
    if (
      [...this.bus.state.projects.values()].some(
        (other) => other.id !== commandProjectId && sameDirectory(other.directory, resolved),
      )
    ) {
      return rejected('invalidCommand', `Directory '${resolved}' is already linked`);
    }
    if (sameDirectory(project.directory, resolved)) {
      return ok();
    }
    await this.bus.publish(commandProjectId, 'projectDirectoryChanged', {
      projectId: commandProjectId,
      directory: resolved,
    });
    return ok();
  }

  private async activateProject(projectId: string): Promise<CommandOutcome> {
    if (!this.bus.state.projects.has(projectId)) {
      return rejected('unknownProject', `Unknown project ${projectId}`);
    }
    await this.bus.publish(projectId, 'projectActivated', { projectId });
    return ok();
  }

  private async archiveProject(
    scope: string | undefined,
    commandProjectId: string,
  ): Promise<CommandOutcome> {
    if (scope !== commandProjectId) {
      return rejected('unknownProject', `Unknown project ${scope ?? ''}`);
    }
    const project = this.bus.state.projects.get(commandProjectId);
    if (!project) {
      return rejected('unknownProject', `Unknown project ${commandProjectId}`);
    }
    if (project.isArchived) return ok();
    const activeRuns = [...(this.bus.state.byProject.get(commandProjectId)?.runs.values() ?? [])].some(
      (run) => run.isActive,
    );
    if (activeRuns) {
      return rejected('invalidCommand', `Project ${commandProjectId} has an active pipeline run`);
    }
    await this.bus.publish(commandProjectId, 'projectArchived', {
      projectId: commandProjectId,
      archivedAt: nowIso(),
    });
    return ok();
  }

  private async restoreProject(
    scope: string | undefined,
    commandProjectId: string,
  ): Promise<CommandOutcome> {
    if (scope !== commandProjectId) {
      return rejected('unknownProject', `Unknown project ${scope ?? ''}`);
    }
    const project = this.bus.state.projects.get(commandProjectId);
    if (!project) {
      return rejected('unknownProject', `Unknown project ${commandProjectId}`);
    }
    if (!project.isArchived) return ok();
    await this.bus.publish(commandProjectId, 'projectRestored', {
      projectId: commandProjectId,
      restoredAt: nowIso(),
    });
    return ok();
  }

  // ---- Cards ----

  /**
   * Creates one or more cards (v1 `create_cards`): the scope must exist and
   * every `blockedBy` must reference a card that exists at command time
   * (in-batch cross-references are planner-ticket territory, not this).
   * Every card is assigned to a pipeline — the requested one, else the
   * project's default — and begins in that pipeline's first stage.
   * Events publish per card, so each allocation sees the previous one.
   */
  private async createCards(scope: string | undefined, cards: CardJson[]): Promise<CommandOutcome> {
    if (scope === undefined || !this.bus.state.projects.has(scope)) {
      return rejected('unknownProject', `Unknown project ${scope ?? ''}`);
    }
    if (cards.length === 0) {
      return rejected('invalidCommand', 'No cards to create');
    }
    const existing = this.cardsOf(scope);
    for (const card of cards) {
      if (card.blockedBy.some((id) => !existing.has(id))) {
        return rejected('invalidCommand', `blockedBy of '${card.title}' references unknown cards`);
      }
    }

    const now = nowIso();
    for (const card of cards) {
      const pipeline =
        card.pipelineId !== ''
          ? this.pipelinesOf(scope).get(card.pipelineId)
          : this.defaultPipelineOf(scope);
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
        id: card.id !== '' ? card.id : this.allocateCardId(scope),
        projectId: scope,
        pipelineId: pipeline.id,
        stageId: pipeline.firstStage().id,
        stepStates: card.stepStates ?? {},
        createdAt: isSet(card.createdAt) ? card.createdAt : now,
        updatedAt: now,
      });
      existing.set(created.id, created);
      await this.bus.publish(scope, 'cardCreated', { card: created });
      if (isBlockedIn(existing, created, this.pipelinesOf(scope))) {
        await this.bus.publish(scope, 'dependencyStateChanged', {
          cardId: created.id,
          blocked: true,
          blockedBy: created.blockedBy,
        });
      }
    }
    return ok();
  }

  /** The board a scoped card command answers from, or the unknown-card rejection. */
  private cardBoard(scope: string | undefined, cardId: string): Board | CommandOutcome {
    const board = this.boardOf(scope ?? '');
    if (scope === undefined || board === undefined) {
      return rejected('unknownCard', `Unknown card ${cardId}`);
    }
    return board;
  }

  /**
   * Runs a card transition: the board answers with its events (or a typed
   * rejection), and the events publish in order under the write lock.
   */
  private async transition(
    projectId: string | undefined,
    answer: () => PendingEvent[],
  ): Promise<CommandOutcome> {
    let events: PendingEvent[];
    try {
      events = answer();
    } catch (error) {
      return toRejection(error);
    }
    for (const pending of events) {
      await this.bus.publish(projectId, pending.name, pending.body);
    }
    return ok();
  }

  /**
   * Moves a card to a stage of its assigned pipeline: the move needs no
   * active run (the pipeline owns transitions while one runs), the target
   * must be a stage of the card's pipeline, the same stage is a no-op, and
   * unsatisfied blockers reject unless overridden. Dependents whose
   * blocked-ness flips get a dependencyStateChanged.
   */
  private async moveCardStage(
    scope: string | undefined,
    cardId: string,
    toStageId: string,
    override: boolean,
    comment: string | undefined,
  ): Promise<CommandOutcome> {
    const board = this.cardBoard(scope, cardId);
    if (isOutcome(board)) return board;
    return this.transition(scope!, () => board.moveCard(cardId, toStageId, override, comment));
  }

  /**
   * Assigns a card to a pipeline (it appears on that pipeline's board tab).
   * The assignment always places the card in the pipeline's first stage;
   * assigning a completed card reopens it. Needs no active run.
   */
  private async assignCardPipeline(
    scope: string | undefined,
    cardId: string,
    pipelineId: string,
  ): Promise<CommandOutcome> {
    const board = this.cardBoard(scope, cardId);
    if (isOutcome(board)) return board;
    return this.transition(scope!, () => board.assignPipeline(cardId, pipelineId));
  }

  /** Reopens a completed card: it returns to its pipeline's first stage. */
  private async reopenCard(scope: string | undefined, cardId: string): Promise<CommandOutcome> {
    const board = this.cardBoard(scope, cardId);
    if (isOutcome(board)) return board;
    return this.transition(scope!, () => board.reopenCard(cardId));
  }

  /** Changes a card's type (v1 `change_card_type`); the fold resets step states. */
  private async changeCardType(
    scope: string | undefined,
    cardId: string,
    toType: CardType,
  ): Promise<CommandOutcome> {
    const board = this.cardBoard(scope, cardId);
    if (isOutcome(board)) return board;
    return this.transition(scope!, () => board.changeType(cardId, toType));
  }

  /** Assigns (or unassigns) a card; the assignee rides the event (v1 §3.4). */
  private async assignCard(
    scope: string | undefined,
    cardId: string,
    assignee: Assignee | undefined,
  ): Promise<CommandOutcome> {
    const board = this.cardBoard(scope, cardId);
    if (isOutcome(board)) return board;
    return this.transition(scope!, () => board.assign(cardId, assignee));
  }

  /** Archives a card (v1 `archive_card`); dependents re-derive blocking. */
  private async archiveCard(scope: string | undefined, cardId: string): Promise<CommandOutcome> {
    const board = this.cardBoard(scope, cardId);
    if (isOutcome(board)) return board;
    return this.transition(scope!, () => board.archive(cardId));
  }

  /** Updates one step's execution state; the card must be idle. */
  private async updateStepState(
    scope: string | undefined,
    cardId: string,
    stepId: string,
    status: SubStateStatus,
  ): Promise<CommandOutcome> {
    const board = this.cardBoard(scope, cardId);
    if (isOutcome(board)) return board;
    return this.transition(scope!, () => board.updateStepState(cardId, stepId, status));
  }

  /** Toggles a stage's automation (v1 `toggle_automation`), per pipeline stage. */
  private async toggleAutomation(
    scope: string | undefined,
    pipelineId: string,
    stageId: string,
    on: boolean,
  ): Promise<CommandOutcome> {
    if (scope === undefined || !this.bus.state.projects.has(scope)) {
      return rejected('unknownProject', `Unknown project ${scope ?? ''}`);
    }
    const board = this.boardOf(scope);
    if (board === undefined) {
      return rejected('unknownProject', `Unknown project ${scope}`);
    }
    return this.transition(scope, () => board.toggleAutomation(pipelineId, stageId, on));
  }

  // ---- Planning ----

  /** Opens a planning session (v1 `create_session`); the command names the project. */
  private async createPlanningSession(projectId: string): Promise<CommandOutcome> {
    if (!this.bus.state.projects.has(projectId)) {
      return rejected('unknownProject', `Unknown project ${projectId}`);
    }
    const session: PlanningSession = {
      id: allocateId(this.sessionsOf(projectId).keys(), 'S'),
      projectId,
      createdAt: nowIso(),
      status: 'drafting',
      messages: [],
      planDocument: '',
    };
    await this.bus.publish(projectId, 'planningSessionCreated', { session });
    return ok();
  }

  /** Appends a user message (v1 `user_message`); drafting sessions only. */
  private async userMessage(
    scope: string | undefined,
    sessionId: string,
    text: string,
  ): Promise<CommandOutcome> {
    const found = this.findSession(scope, sessionId);
    if (!found) {
      return rejected('unknownSession', `Unknown session ${sessionId}`);
    }
    let message: ChatMessage;
    try {
      message = Planning.of(found.session).userMessage(text);
    } catch (error) {
      return toRejection(error);
    }
    await this.bus.publish(found.projectId, 'userMessageReceived', {
      sessionId: found.session.id,
      message,
    });
    return ok();
  }

  /** Replaces the plan document wholesale (v1 `update_plan_document`). */
  private async updatePlanDocument(
    scope: string | undefined,
    sessionId: string,
    document: string,
  ): Promise<CommandOutcome> {
    const found = this.findSession(scope, sessionId);
    if (!found) {
      return rejected('unknownSession', `Unknown session ${sessionId}`);
    }
    try {
      Planning.of(found.session).requireDocumentOpen();
    } catch (error) {
      return toRejection(error);
    }
    await this.bus.publish(found.projectId, 'planDocumentUpdated', {
      sessionId: found.session.id,
      document,
    });
    return ok();
  }

  /**
   * Emits the planner's tickets as cards (v1 `create_tickets`): in-batch
   * keys remap onto the freshly assigned card ids, `blockedBy` entries must
   * name an existing card or another ticket's key (never the ticket
   * itself), and the session closes.
   */
  private async createTickets(
    scope: string | undefined,
    sessionId: string,
    tickets: TicketEmission[],
  ): Promise<CommandOutcome> {
    const found = this.findSession(scope, sessionId);
    if (!found) {
      return rejected('unknownSession', `Unknown session ${sessionId}`);
    }
    const cards = this.cardsOf(found.projectId);
    try {
      Planning.of(found.session).requireDrafting('its tickets were already emitted');
      Planning.validateTickets(tickets, cards);
    } catch (error) {
      return toRejection(error);
    }

    const first = Number(allocateId(cards.keys(), 'T').slice(2));
    const cardIdByKey = new Map<string, string>();
    const ids: string[] = tickets.map((_, offset) => `T-${first + offset}`);
    tickets.forEach((ticket, offset) => {
      if (ticket.key !== undefined) cardIdByKey.set(ticket.key, ids[offset]!);
    });

    const pipeline = this.defaultPipelineOf(found.projectId);
    if (pipeline === undefined) {
      return rejected('invalidCommand', `Project ${found.projectId} has no pipeline to assign the tickets to`);
    }
    const now = nowIso();
    const emitted: Card[] = tickets.map(
      (ticket, offset) =>
        new Card({
          id: ids[offset]!,
          projectId: found.projectId,
          type: ticket.cardType,
          title: ticket.title,
          description: ticket.description,
          tags: [],
          pipelineId: pipeline.id,
          stageId: pipeline.firstStage().id,
          blockedBy: ticket.blockedBy.map((dep) => cardIdByKey.get(dep) ?? dep),
          stepStates: {},
          sessionId: found.session.id,
          createdAt: now,
          updatedAt: now,
        }),
    );

    await this.bus.publish(found.projectId, 'cardsCommitted', { cards: emitted });
    for (const card of emitted) {
      if (card.blockedBy.length === 0) continue;
      await this.bus.publish(found.projectId, 'dependencyStateChanged', {
        cardId: card.id,
        blocked: true,
        blockedBy: card.blockedBy,
      });
    }
    await this.bus.publish(found.projectId, 'planningSessionCompleted', {
      sessionId: found.session.id,
    });
    return ok();
  }

  // ---- Card helpers ----

  /**
   * The project's cards as a scratch map: a shallow copy of the fold's map —
   * the immutable instances are shared, and in-flight batches (a card the
   * next card in the batch may block on) mutate the copy, never the state.
   */
  private cardsOf(projectId: string): Map<string, Card> {
    const cards = this.bus.state.byProject.get(projectId)?.cards;
    return cards !== undefined ? new Map(cards) : new Map();
  }

  private allocateCardId(projectId: string): string {
    return allocateId(this.cardsOf(projectId).keys(), 'T');
  }

  private sessionsOf(projectId: string): Map<string, PlanningSession> {
    return this.bus.state.byProject.get(projectId)?.planningSessions ?? new Map();
  }

  private findSession(
    scope: string | undefined,
    sessionId: string,
  ): { projectId: string; session: PlanningSession } | null {
    if (scope === undefined) return null;
    const session = this.sessionsOf(scope).get(sessionId);
    return session ? { projectId: scope, session } : null;
  }

  // ---- Pipelines ----

  /**
   * Saves a user-authored pipeline: an empty id allocates the next `PL-N`,
   * a known id upserts. The definition is validated in full (stages, the
   * forward path, terminal stage); a save that changes nothing is a no-op,
   * a changed save allocates the next revision — active and historical runs
   * keep the revision they started on.
   */
  private async savePipeline(scope: string | undefined, pipeline: PipelineJson): Promise<CommandOutcome> {
    if (scope === undefined || !this.bus.state.projects.has(scope)) {
      return rejected('unknownProject', `Unknown project ${scope ?? ''}`);
    }
    let stages: PipelineStageJson[];
    try {
      stages = Pipeline.validateDraft(pipeline);
    } catch (error) {
      return toRejection(error);
    }
    const name = pipeline.name.trim();
    const id = pipeline.id.trim() !== '' ? pipeline.id.trim() : allocateId(this.pipelinesOf(scope).keys(), 'PL');
    const current = this.pipelinesOf(scope).get(id);
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
    await this.bus.publish(scope, 'pipelineSaved', { pipeline: saved });
    return ok();
  }

  /**
   * Deletes a user-authored pipeline (v1 `delete_pipeline`): the tombstone
   * keeps the boot seed from resurrecting the default. A pipeline with
   * assigned cards rejects — reassign them first.
   */
  private async deletePipeline(scope: string | undefined, pipelineId: string): Promise<CommandOutcome> {
    if (scope === undefined || !this.pipelinesOf(scope).has(pipelineId)) {
      return rejected('unknownPipeline', `Unknown pipeline ${pipelineId}`);
    }
    const assigned = [...this.cardsOf(scope).values()].filter((card) => card.pipelineId === pipelineId);
    if (assigned.length > 0) {
      return rejected(
        'invalidCommand',
        `Pipeline ${pipelineId} still has ${assigned.length} assigned card${assigned.length === 1 ? '' : 's'}`,
      );
    }
    await this.bus.publish(scope, 'pipelineDeleted', { pipelineId });
    return ok();
  }

  /**
   * Runs a card's assigned pipeline: the validated run event allocates the
   * run (pinned to the pipeline's current revision) and is the runner's
   * trigger. The run executes from the card's current stage onward.
   */
  private async runPipeline(scope: string | undefined, cardId: string): Promise<CommandOutcome> {
    if (scope === undefined || !this.bus.state.projects.has(scope)) {
      return rejected('unknownProject', `Unknown project ${scope ?? ''}`);
    }
    const board = this.boardOf(scope);
    if (board === undefined) {
      return rejected('unknownCard', `Unknown card ${cardId}`);
    }
    let pipeline: Pipeline;
    try {
      ({ pipeline } = board.requireRunnableCard(cardId));
    } catch (error) {
      return toRejection(error);
    }
    if (this.bus.state.projects.get(scope)?.directory === undefined) {
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

    const runId = allocateId(this.runsOf(scope).keys(), 'R');
    await this.bus.publish(scope, 'pipelineRunStarted', {
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
  private async stopPipeline(scope: string | undefined, cardId: string): Promise<CommandOutcome> {
    if (scope === undefined) {
      return this.unknownCardOrNotRunning(scope, cardId);
    }
    const board = this.boardOf(scope);
    if (board === undefined) {
      return rejected('unknownCard', `Unknown card ${cardId}`);
    }
    let run: Run;
    try {
      run = board.requireStoppable(cardId);
    } catch (error) {
      return toRejection(error);
    }
    await this.bus.publish(scope, 'pipelineRunEnded', {
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
  private async gateRespond(
    scope: string | undefined,
    cardId: string,
    approved: boolean,
    comment: string | undefined,
  ): Promise<CommandOutcome> {
    if (scope === undefined) {
      return this.unknownCardOrNotRunning(scope, cardId);
    }
    const board = this.boardOf(scope);
    if (board === undefined) {
      return rejected('unknownCard', `Unknown card ${cardId}`);
    }
    let run: Run;
    try {
      run = board.requireGateWait(cardId);
    } catch (error) {
      return toRejection(error);
    }
    await this.bus.publish(scope, 'pipelineGateResponded', {
      runId: run.id,
      cardId,
      approved,
      ...(comment !== undefined ? { comment } : {}),
    });
    return ok();
  }

  /** The stop/gate rejection when the scope names no card at all. */
  private unknownCardOrNotRunning(scope: string | undefined, cardId: string): CommandOutcome {
    const unknown = this.boardOf(scope ?? '')?.card(cardId) === undefined;
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
  private async reportOutcome(
    scope: string | undefined,
    sessionId: string,
    outcome: string,
    note: string | undefined,
  ): Promise<CommandOutcome> {
    if (scope === undefined || !this.bus.state.projects.has(scope)) {
      return rejected('unknownProject', `Unknown project ${scope ?? ''}`);
    }
    const board = this.boardOf(scope);
    const session = this.bus.state.byProject.get(scope)?.agentSessions.get(sessionId);
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
      await this.bus.publish(scope, 'pipelineOutcomeReported', {
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

  private pipelinesOf(projectId: string): Map<string, Pipeline> {
    return this.bus.state.byProject.get(projectId)?.pipelines ?? new Map();
  }

  private runsOf(projectId: string): Map<string, Run> {
    return this.bus.state.byProject.get(projectId)?.runs ?? new Map();
  }

  /** The project's board (the aggregate the link rules are answered from). */
  private boardOf(projectId: string): Board | undefined {
    const project = this.bus.state.byProject.get(projectId);
    return project !== undefined ? Board.of(project) : undefined;
  }

  /** The card's active run, if any (at most one). */
  private activeRunOf(projectId: string | undefined, cardId: string): Run | null {
    return this.boardOf(projectId ?? '')?.activeRun(cardId) ?? null;
  }

  /** The project's default pipeline: PL-1 when present, else the first by id. */
  private defaultPipelineOf(projectId: string): Pipeline | undefined {
    return this.boardOf(projectId)?.defaultPipeline();
  }

  // ---- Global assistant (Phase 6): commands without a project scope ----

  /** Opens a named thread; an empty name defaults to `Thread N`. */
  private async createAssistantThread(name: string | undefined): Promise<CommandOutcome> {
    const id = allocateId(this.bus.state.assistantThreads.keys(), 'TH');
    const trimmed = name?.trim() ?? '';
    const thread: AssistantThread = {
      id,
      name: trimmed !== '' ? trimmed : `Thread ${id.slice(3)}`,
      createdAt: nowIso(),
      status: 'idle',
      projectIds: [],
      messages: [],
    };
    await this.bus.publish(undefined, 'assistantThreadCreated', { thread });
    return ok();
  }

  private async archiveAssistantThread(threadId: string): Promise<CommandOutcome> {
    const found = this.findThread(threadId);
    if (!found) {
      return rejected('unknownThread', `Unknown thread ${threadId}`);
    }
    return this.transition(undefined, () => Thread.of(found).archiveEvents());
  }

  private async restoreAssistantThread(threadId: string): Promise<CommandOutcome> {
    const found = this.findThread(threadId);
    if (!found) {
      return rejected('unknownThread', `Unknown thread ${threadId}`);
    }
    return this.transition(undefined, () => Thread.of(found).restoreEvents());
  }

  /**
   * Replaces the thread's project scope wholesale: every project must exist
   * and be active (archived projects leave no scope behind), duplicates
   * collapse preserving order. Archived threads reject scope edits —
   * restore first.
   */
  private async setAssistantThreadScope(
    threadId: string,
    projectIds: string[],
  ): Promise<CommandOutcome> {
    const found = this.findThread(threadId);
    if (!found) {
      return rejected('unknownThread', `Unknown thread ${threadId}`);
    }
    return this.transition(undefined, () =>
      Thread.of(found).scopeEvents(projectIds, (id) => this.bus.state.projects.get(id)),
    );
  }

  /** Appends a user message to the thread (archived threads are closed). */
  private async assistantMessage(threadId: string, text: string): Promise<CommandOutcome> {
    const found = this.findThread(threadId);
    if (!found) {
      return rejected('unknownThread', `Unknown thread ${threadId}`);
    }
    return this.transition(undefined, () => Thread.of(found).messageEvents(text));
  }

  /**
   * Edit-and-resend (Phase 7): publishes the edited user message as a
   * sibling of the original (same `parentId`, fresh id and index) — the
   * prior branch stays intact and the orchestrator runs a turn for the new
   * message.
   */
  private async resendAssistantMessage(
    threadId: string,
    messageId: string,
    text: string,
  ): Promise<CommandOutcome> {
    const found = this.findThread(threadId);
    if (!found) {
      return rejected('unknownThread', `Unknown thread ${threadId}`);
    }
    return this.transition(undefined, () => Thread.of(found).resendEvents(messageId, text));
  }

  // ---- Work proposals (Phase 8) ----

  private static readonly MAX_PROPOSAL_ITEMS = 50;

  /**
   * Records the assistant's draft (the propose_cards MCP tool lands here).
   * Everything is validated up front — scope, shape, and dependencies — so
   * the tool result can teach the model before the user ever sees it.
   */
  private async draftProposal(threadId: string, items: ProposalItem[]): Promise<CommandOutcome> {
    const found = this.findThread(threadId);
    if (!found) {
      return rejected('unknownThread', `Unknown thread ${threadId}`);
    }
    const thread = Thread.of(found);
    try {
      thread.requireOpen();
      if (items.length === 0) {
        throw new CommandRejection('invalidCommand', 'No proposal items provided');
      }
      if (items.length > Processor.MAX_PROPOSAL_ITEMS) {
        throw new CommandRejection('invalidCommand', `A proposal carries at most ${Processor.MAX_PROPOSAL_ITEMS} items`);
      }
      const keys = items.filter((item) => item.key !== undefined).map((item) => item.key!);
      if (new Set(keys).size !== keys.length) {
        throw new CommandRejection('invalidCommand', 'Proposal item keys must be unique');
      }
      const keySet = new Set(keys);
      for (const item of items) {
        thread.requireInScope(item.projectId);
        const error = validateProposalItem(item, this.cardsOf(item.projectId), keySet);
        if (error !== null) throw new CommandRejection('invalidCommand', error);
      }
    } catch (error) {
      return toRejection(error);
    }

    const proposal: CardProposal = {
      id: allocateId(this.bus.state.proposals.keys(), 'PR'),
      threadId,
      createdAt: nowIso(),
      status: 'drafted',
      items: items.map((item) => ({
        ...item,
        id: randomUUID(),
        included: true,
      })),
    };
    await this.bus.publish(undefined, 'proposalDrafted', { proposal });
    return ok();
  }

  /**
   * Confirms a proposal: the (possibly edited) items land as cards through
   * the validated processor, as one independent batch per target project —
   * a project that fails validation reports an explicit error while the
   * others proceed. Everything is re-validated against current state.
   */
  private async confirmProposal(proposalId: string, items: ProposalItem[]): Promise<CommandOutcome> {
    const proposal = this.bus.state.proposals.get(proposalId);
    if (!proposal) {
      return rejected('unknownProposal', `Unknown proposal ${proposalId}`);
    }
    try {
      Proposal.of(proposal).requireDrafted();
    } catch (error) {
      return toRejection(error);
    }
    const included = items.filter((item) => item.included);
    if (included.length === 0) {
      return rejected('invalidCommand', 'No proposal items are included');
    }
    for (const item of items) {
      if (!this.bus.state.projects.has(item.projectId)) {
        return rejected('invalidCommand', `Unknown project ${item.projectId}`);
      }
    }

    const outcomes: ProposalOutcome[] = [];
    for (const projectId of [...new Set(included.map((item) => item.projectId))]) {
      const batch = included.filter((item) => item.projectId === projectId);
      const keys = batch.filter((item) => item.key !== undefined).map((item) => item.key!);
      const keySet = new Set(keys);
      let rejection: string | null = null;
      for (const item of batch) {
        const error = validateProposalItem(item, this.cardsOf(projectId), keySet);
        if (error !== null) {
          rejection = error;
          break;
        }
      }

      if (rejection !== null) {
        outcomes.push({ projectId, ok: false, error: rejection });
        continue;
      }

      const cards = this.cardsOf(projectId);
      const first = Number(allocateId(cards.keys(), 'T').slice(2));
      const ids: string[] = batch.map((_, offset) => `T-${first + offset}`);
      const cardIdByKey = new Map<string, string>();
      batch.forEach((item, offset) => {
        if (item.key !== undefined) cardIdByKey.set(item.key, ids[offset]!);
      });
      const pipeline = this.defaultPipelineOf(projectId);
      if (pipeline === undefined) {
        outcomes.push({ projectId, ok: false, error: `project ${projectId} has no pipeline to assign the cards to` });
        continue;
      }
      const now = nowIso();
      const created: Card[] = batch.map(
        (item, offset) =>
          new Card({
            id: ids[offset]!,
            projectId,
            type: item.cardType,
            title: item.title,
            description: item.description,
            tags: [],
            pipelineId: pipeline.id,
            stageId: pipeline.firstStage().id,
            blockedBy: item.blockedBy.map((dep) => cardIdByKey.get(dep) ?? dep),
            stepStates: {},
            createdAt: now,
            updatedAt: now,
          }),
      );
      await this.bus.publish(projectId, 'cardsCommitted', { cards: created });
      for (const card of created) {
        if (card.blockedBy.length === 0) continue;
        await this.bus.publish(projectId, 'dependencyStateChanged', {
          cardId: card.id,
          blocked: true,
          blockedBy: card.blockedBy,
        });
      }
      outcomes.push({ projectId, ok: true, cardIds: ids });
    }

    await this.bus.publish(undefined, 'proposalConfirmed', {
      proposalId,
      items,
      outcomes,
      confirmedAt: nowIso(),
    });
    return ok();
  }

  private async discardProposal(proposalId: string): Promise<CommandOutcome> {
    const proposal = this.bus.state.proposals.get(proposalId);
    if (!proposal) {
      return rejected('unknownProposal', `Unknown proposal ${proposalId}`);
    }
    try {
      Proposal.of(proposal).requireDrafted();
    } catch (error) {
      return toRejection(error);
    }
    await this.bus.publish(undefined, 'proposalDiscarded', { proposalId });
    return ok();
  }

  // ---- Docs (Phase 9): validated writes over the project's docs/ files ----

  /** Creates or overwrites one doc; the event carries metadata only. */
  private async saveDoc(
    scope: string | undefined,
    path: string,
    content: string,
  ): Promise<CommandOutcome> {
    const directory = this.directoryOf(scope);
    if (typeof directory !== 'string') return directory;
    const result = saveDocFile(directory, path, content);
    if (!result.ok) return rejected('invalidCommand', result.error);
    await this.bus.publish(scope!, 'docSaved', { doc: result.value });
    return ok();
  }

  /** Deletes one doc; the tombstone is project-scoped, by path. */
  private async deleteDoc(scope: string | undefined, path: string): Promise<CommandOutcome> {
    const directory = this.directoryOf(scope);
    if (typeof directory !== 'string') return directory;
    const result = deleteDocFile(directory, path);
    if (!result.ok) return rejected('invalidCommand', result.error);
    await this.bus.publish(scope!, 'docDeleted', { path });
    return ok();
  }

  /**
   * Renames one doc (a single on-disk rename): the new metadata lands as
   * docSaved before the old path's docDeleted, so folds see an upsert
   * then the tombstone in either order. Same path is a no-op.
   */
  private async renameDoc(scope: string | undefined, path: string, to: string): Promise<CommandOutcome> {
    const directory = this.directoryOf(scope);
    if (typeof directory !== 'string') return directory;
    if (path === to) return ok();
    const result = renameDocFile(directory, path, to);
    if (!result.ok) return rejected('invalidCommand', result.error);
    await this.bus.publish(scope!, 'docSaved', { doc: result.value });
    await this.bus.publish(scope!, 'docDeleted', { path });
    return ok();
  }

  /** The linked directory of a file-backed command's scope, or the rejection. */
  private directoryOf(scope: string | undefined): string | CommandOutcome {
    if (scope === undefined || !this.bus.state.projects.has(scope)) {
      return rejected('unknownProject', `Unknown project ${scope ?? ''}`);
    }
    const directory = this.bus.state.projects.get(scope)!.directory;
    if (directory === undefined) {
      return rejected('invalidCommand', `Project ${scope} has no directory set`);
    }
    return directory;
  }

  // ---- Knowledge (Phase 9): global writes over the data-dir library ----

  /**
   * Saves a note: with a path the content is the exact file (the
   * desktop's edit flow), without one title/tags frontmatter it and a
   * unique slug filename (the agent's save tool).
   */
  private async saveKnowledge(command: {
    path?: string;
    title?: string;
    tags?: string[];
    content: string;
  }): Promise<CommandOutcome> {
    if (this.knowledge === undefined) {
      return rejected('invalidCommand', 'knowledge storage is unavailable');
    }
    const result =
      command.path !== undefined && command.path.trim() !== ''
        ? this.knowledge.saveToFile(command.path, command.content)
        : this.knowledge.createEntry({
            title: command.title ?? '',
            tags: command.tags,
            content: command.content,
          });
    if (!result.ok) return rejected('invalidCommand', result.error);
    await this.bus.publish(undefined, 'knowledgeSaved', { entry: result.value });
    return { ok: true, savedPath: result.value.path };
  }

  /** Deletes one note; the tombstone is global, by path. */
  private async deleteKnowledge(path: string): Promise<CommandOutcome> {
    if (this.knowledge === undefined) {
      return rejected('invalidCommand', 'knowledge storage is unavailable');
    }
    const result = this.knowledge.delete(path);
    if (!result.ok) return rejected('invalidCommand', result.error);
    await this.bus.publish(undefined, 'knowledgeDeleted', { path });
    return ok();
  }

  // ---- Agent workflows (S34): worker agents record procedures ----

  /**
   * One open recording: the processor's in-memory state between the
   * agent's start and stop tool calls. A restart (or a crashed run) drops
   * it — only a stopped recording is durable. Keyed by
   * `<projectId>/<sessionId>`.
   */
  private readonly workflowRecordings = new Map<
    string,
    { title: string; description: string; tags: string[]; source?: string; agent?: string; steps: WorkflowStep[]; startedAt: string }
  >();

  private workflowRecordingKey(projectId: string | undefined, sessionId: string): string | null {
    if (projectId === undefined || projectId === '') return null;
    return `${projectId}/${sessionId}`;
  }

  private async startWorkflowRecording(
    projectId: string | undefined,
    sessionId: string,
    title: string,
    description?: string,
    tags?: string[],
  ): Promise<CommandOutcome> {
    const directory = this.directoryOf(projectId);
    if (typeof directory !== 'string') return directory;
    const key = this.workflowRecordingKey(projectId, sessionId);
    if (key === null) return rejected('invalidCommand', 'a workflow recording needs a session');
    const session = this.bus.state.byProject.get(projectId!)?.agentSessions.get(sessionId);
    if (session === undefined) {
      return rejected('unknownSession', `Unknown agent session ${sessionId}`);
    }
    if (session.status !== 'running') {
      return rejected('invalidCommand', `Agent session ${sessionId} is not running`);
    }
    if (this.workflowRecordings.has(key)) {
      return rejected('invalidCommand', `Session ${sessionId} already has an open workflow recording`);
    }
    const trimmed = title.trim();
    if (trimmed === '') return rejected('invalidCommand', 'a workflow needs a title');
    this.workflowRecordings.set(key, {
      title: trimmed,
      description: description?.trim() ?? '',
      tags: (tags ?? []).map((tag) => tag.trim()).filter((tag) => tag !== ''),
      // The card and the worker the session belongs to (a pipeline agent
      // session's bound card and step kind).
      ...(session.cardId !== '' ? { source: session.cardId } : {}),
      ...(session.agentKind !== undefined ? { agent: session.agentKind } : {}),
      steps: [],
      startedAt: nowIso(),
    });
    return ok();
  }

  private async addWorkflowRecordingStep(
    projectId: string | undefined,
    sessionId: string,
    step: WorkflowStep,
  ): Promise<CommandOutcome> {
    const key = this.workflowRecordingKey(projectId, sessionId);
    const recording = key !== null ? this.workflowRecordings.get(key) : undefined;
    if (key === null || recording === undefined) {
      return rejected('invalidCommand', `Session ${sessionId} has no open workflow recording`);
    }
    const title = step.title.trim();
    if (title === '') return rejected('invalidCommand', 'a workflow step needs a title');
    if (recording.steps.length >= MAX_WORKFLOW_STEPS) {
      return rejected('invalidCommand', `a workflow may not exceed ${MAX_WORKFLOW_STEPS} steps`);
    }
    recording.steps.push({
      title,
      ...(step.detail?.trim() ? { detail: step.detail.trim() } : {}),
      ...(step.command?.trim() ? { command: step.command.trim() } : {}),
    });
    return ok();
  }

  private async stopWorkflowRecording(
    projectId: string | undefined,
    sessionId: string,
    links?: string[],
  ): Promise<CommandOutcome> {
    const directory = this.directoryOf(projectId);
    if (typeof directory !== 'string') return directory;
    const key = this.workflowRecordingKey(projectId, sessionId);
    const recording = key !== null ? this.workflowRecordings.get(key) : undefined;
    if (key === null || recording === undefined) {
      return rejected('invalidCommand', `Session ${sessionId} has no open workflow recording`);
    }
    if (recording.steps.length === 0) {
      return rejected('invalidCommand', 'a workflow needs at least one step — add steps or keep recording');
    }
    const result = saveWorkflow(directory, {
      title: recording.title,
      ...(recording.description !== '' ? { description: recording.description } : {}),
      tags: recording.tags,
      ...(recording.source !== undefined ? { source: recording.source } : {}),
      ...(recording.agent !== undefined ? { agent: recording.agent } : {}),
      steps: recording.steps,
      links,
      recordedAt: recording.startedAt,
    });
    if (!result.ok) return rejected('invalidCommand', result.error);
    this.workflowRecordings.delete(key);
    await this.bus.publish(projectId!, 'workflowSaved', { workflow: result.value });
    return { ok: true, savedPath: result.value.path };
  }

  /** Deletes one recorded workflow; the tombstone is project-scoped, by path. */
  private async deleteWorkflow(projectId: string | undefined, path: string): Promise<CommandOutcome> {
    const directory = this.directoryOf(projectId);
    if (typeof directory !== 'string') return directory;
    const result = deleteWorkflowFile(directory, path);
    if (!result.ok) return rejected('invalidCommand', result.error);
    await this.bus.publish(projectId!, 'workflowDeleted', { path });
    return ok();
  }

  private assistantThreads(): Map<string, AssistantThread> {
    return this.bus.state.assistantThreads;
  }

  /**
   * Stops a running response (Phase 7): the canonical record is the
   * orchestrator's kill trigger; the fold marks the thread `stopped`.
   */
  private async stopAssistantThread(threadId: string): Promise<CommandOutcome> {
    const found = this.findThread(threadId);
    if (!found) {
      return rejected('unknownThread', `Unknown thread ${threadId}`);
    }
    return this.transition(undefined, () => Thread.of(found).stopEvents());
  }

  /**
   * Re-runs the thread's last user message (Phase 7): the reply appends an
   * alternate response — nothing in the transcript is rewritten.
   */
  private async retryAssistantThread(threadId: string): Promise<CommandOutcome> {
    const found = this.findThread(threadId);
    if (!found) {
      return rejected('unknownThread', `Unknown thread ${threadId}`);
    }
    return this.transition(undefined, () => Thread.of(found).retryEvents());
  }

  private async renameAssistantThread(threadId: string, name: string): Promise<CommandOutcome> {
    const found = this.findThread(threadId);
    if (!found) {
      return rejected('unknownThread', `Unknown thread ${threadId}`);
    }
    return this.transition(undefined, () => Thread.of(found).renameEvents(name));
  }

  /** The named thread record, or null. */
  private findThread(threadId: string): AssistantThread | null {
    return this.assistantThreads().get(threadId) ?? null;
  }
}

function ok(): CommandOutcome {
  return { ok: true };
}

function rejected(code: Rejection['code'], message: string): CommandOutcome {
  return { ok: false, rejection: { code, message } };
}

/** A transition's typed rejection becomes the wire outcome unchanged. */
function toRejection(error: unknown): CommandOutcome {
  if (error instanceof CommandRejection) return rejected(error.code, error.message);
  throw error;
}

function isOutcome(value: Board | CommandOutcome): value is CommandOutcome {
  return 'ok' in value;
}

/** A timestamp the client actually set (v1's DEFAULT_TIMESTAMP sentinel → absent here). */
function isSet(timestamp: string): boolean {
  return timestamp !== '' && Date.parse(timestamp) > 0;
}

/** One past the highest numeric suffix in use ("P-3" → "P-4"). */
export function allocateId(ids: Iterable<string>, prefix: string): string {
  let max = 0;
  for (const id of ids) {
    const match = /^[A-Z]+-(\d+)$/.exec(id);
    if (match && match[1] !== undefined) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return `${prefix}-${max + 1}`;
}

/** Resolves a directory-ish string to an existing absolute path, else null. */
function resolveDirectory(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return null;
  const path = isAbsolute(value) ? value : join(process.cwd(), value);
  const normalized = normalize(path).replace(/[/\\]+$/, '');
  try {
    return statSync(normalized).isDirectory() ? normalized : null;
  } catch {
    return null;
  }
}

function sameDirectory(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  return trimEndingSeparator(left) === trimEndingSeparator(right);
}

function trimEndingSeparator(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  return trimmed === '' ? path : trimmed;
}
