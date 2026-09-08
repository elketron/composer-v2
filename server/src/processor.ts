// Command validation → canonical events (v1 architecture.md §Server
// command validation). Same validation order, same rejection messages, and
// the same emitted event lists as v1 for the domains v2 keeps. Human drags
// are never blocked by automation toggles.

import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import type { Bus } from './bus.js';
import type { Command, CommandOutcome, Rejection, TicketEmission } from './wire/commands.js';
import { nowIso } from './wire/envelope.js';
import {
  type AssistantThread,
  type Assignee,
  type Card as CardJson,
  type CardProposal,
  type CardType,
  type ChatMessage,
  type Pipeline as PipelineJson,
  type PipelineStage,
  type PipelineStep,
  type PlanningSession,
  type ProposalItem,
  type ProposalOutcome,
  type Project,
  type SubStateStatus,
  type WorkflowStep,
} from './wire/models.js';
import { Card, isBlockedIn } from './domain/card.js';
import type { Pipeline } from './domain/pipeline.js';
import type { Run } from './domain/run.js';
import { defaultPipeline, DEFAULT_PIPELINE_ID } from './pipelines.js';
import { PIPELINE_AGENT_KINDS } from './agents.js';
import { deleteDoc as deleteDocFile, renameDoc as renameDocFile, saveDoc as saveDocFile } from './docs.js';
import { deleteWorkflow as deleteWorkflowFile, saveWorkflow, MAX_WORKFLOW_STEPS } from './workflows.js';
import type { KnowledgeStore } from './knowledge.js';

/** Ceiling on steps one pipeline may carry (v1 M3). */
const MAX_PIPELINE_STEPS = 64;

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
    const found = this.findCard(scope, cardId);
    if (!found) {
      return rejected('unknownCard', `Unknown card ${cardId}`);
    }
    const { projectId, card } = found;
    const pipeline = this.pipelinesOf(projectId).get(card.pipelineId);
    if (pipeline === undefined) {
      return rejected('unknownPipeline', `Card ${cardId} has no assigned pipeline`);
    }
    if (pipeline.stageById(toStageId) === undefined) {
      return rejected('unknownStage', `Stage '${toStageId}' is not a stage of pipeline ${pipeline.id}`);
    }
    if (this.activeRunOf(projectId, cardId) !== null) {
      return rejected('runActive', `Card ${cardId} has an active pipeline run`);
    }
    if (card.stageId === toStageId) {
      return ok();
    }
    const before = this.cardsOf(projectId);
    if (!override && isBlockedIn(before, card, this.pipelinesOf(projectId))) {
      return rejected('blocked', `Card ${cardId} has unsatisfied blockers`);
    }

    await this.bus.publish(projectId, 'cardStageMoved', {
      cardId: card.id,
      pipelineId: pipeline.id,
      fromStageId: card.stageId,
      toStageId,
      ...(comment !== undefined ? { comment } : {}),
    });
    const moved = card.with({ stageId: toStageId });
    await this.appendDependencyTransitions(projectId, before, moved);
    return ok();
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
    const found = this.findCard(scope, cardId);
    if (!found) {
      return rejected('unknownCard', `Unknown card ${cardId}`);
    }
    const { projectId, card } = found;
    const pipeline = this.pipelinesOf(projectId).get(pipelineId);
    if (pipeline === undefined) {
      return rejected('unknownPipeline', `Unknown pipeline ${pipelineId}`);
    }
    if (this.activeRunOf(projectId, cardId) !== null) {
      return rejected('runActive', `Card ${cardId} has an active pipeline run`);
    }
    await this.bus.publish(projectId, 'cardPipelineAssigned', {
      cardId: card.id,
      pipelineId: pipeline.id,
      stageId: pipeline.firstStage().id,
    });
    return ok();
  }

  /** Reopens a completed card: it returns to its pipeline's first stage. */
  private async reopenCard(scope: string | undefined, cardId: string): Promise<CommandOutcome> {
    const found = this.findCard(scope, cardId);
    if (!found) {
      return rejected('unknownCard', `Unknown card ${cardId}`);
    }
    const { projectId, card } = found;
    const pipeline = this.pipelinesOf(projectId).get(card.pipelineId);
    if (pipeline === undefined) {
      return rejected('unknownPipeline', `Card ${cardId} has no assigned pipeline`);
    }
    if (!pipeline.isTerminalStage(card.stageId)) {
      return rejected('invalidCommand', `Card ${cardId} is not completed`);
    }
    if (this.activeRunOf(projectId, cardId) !== null) {
      return rejected('runActive', `Card ${cardId} has an active pipeline run`);
    }
    await this.bus.publish(projectId, 'cardStageMoved', {
      cardId: card.id,
      pipelineId: pipeline.id,
      fromStageId: card.stageId,
      toStageId: pipeline.firstStage().id,
    });
    return ok();
  }

  /** Changes a card's type (v1 `change_card_type`); the fold resets step states. */
  private async changeCardType(
    scope: string | undefined,
    cardId: string,
    toType: CardType,
  ): Promise<CommandOutcome> {
    const found = this.findCard(scope, cardId);
    if (!found) {
      return rejected('unknownCard', `Unknown card ${cardId}`);
    }
    if (found.card.type === toType) {
      return ok();
    }
    await this.bus.publish(found.projectId, 'cardTypeChanged', {
      cardId: found.card.id,
      from: found.card.type,
      to: toType,
    });
    return ok();
  }

  /** Assigns (or unassigns) a card; the assignee rides the event (v1 §3.4). */
  private async assignCard(
    scope: string | undefined,
    cardId: string,
    assignee: Assignee | undefined,
  ): Promise<CommandOutcome> {
    const found = this.findCard(scope, cardId);
    if (!found) {
      return rejected('unknownCard', `Unknown card ${cardId}`);
    }
    await this.bus.publish(found.projectId, 'cardAssigned', {
      cardId: found.card.id,
      ...(assignee ? { assignee } : {}),
    });
    return ok();
  }

  /** Archives a card (v1 `archive_card`); dependents re-derive blocking. */
  private async archiveCard(scope: string | undefined, cardId: string): Promise<CommandOutcome> {
    const found = this.findCard(scope, cardId);
    if (!found) {
      return rejected('unknownCard', `Unknown card ${cardId}`);
    }
    await this.bus.publish(found.projectId, 'cardArchived', { cardId: found.card.id });
    return ok();
  }

  /** Updates one step's execution state; the card must be idle. */
  private async updateStepState(
    scope: string | undefined,
    cardId: string,
    stepId: string,
    status: SubStateStatus,
  ): Promise<CommandOutcome> {
    const found = this.findCard(scope, cardId);
    if (!found) {
      return rejected('unknownCard', `Unknown card ${cardId}`);
    }
    const pipeline = this.pipelinesOf(found.projectId).get(found.card.pipelineId);
    if (pipeline === undefined || pipeline.stepById(stepId) === undefined) {
      return rejected('unknownStage', `Step '${stepId}' is not a step of the card's pipeline`);
    }
    if (this.activeRunOf(found.projectId, cardId) !== null) {
      return rejected('runActive', `Card ${cardId} has an active pipeline run`);
    }
    await this.bus.publish(found.projectId, 'cardStepStateUpdated', {
      cardId: found.card.id,
      stepId,
      status,
    });
    return ok();
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
    const pipeline = this.pipelinesOf(scope).get(pipelineId);
    if (pipeline === undefined) {
      return rejected('unknownPipeline', `Unknown pipeline ${pipelineId}`);
    }
    if (pipeline.stageById(stageId) === undefined) {
      return rejected('unknownStage', `Stage '${stageId}' is not a stage of pipeline ${pipelineId}`);
    }
    await this.bus.publish(scope, 'automationToggled', { pipelineId, stageId, on });
    return ok();
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
    if (found.session.status !== 'drafting') {
      return rejected('invalidCommand', `Session ${sessionId} is done; its transcript is closed`);
    }
    if (text.trim() === '') {
      return rejected('invalidCommand', 'Message text is required');
    }
    const message: ChatMessage = {
      index: nextMessageIndex(found.session),
      role: 'user',
      text,
      at: nowIso(),
    };
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
    if (found.session.status !== 'drafting') {
      return rejected('invalidCommand', `Session ${sessionId} is done; its plan document is closed`);
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
    if (found.session.status !== 'drafting') {
      return rejected('invalidCommand', `Session ${sessionId} is done; its tickets were already emitted`);
    }
    if (tickets.length === 0) {
      return rejected('invalidCommand', 'No tickets provided');
    }
    for (const ticket of tickets) {
      if (ticket.title.trim() === '') {
        return rejected('invalidCommand', 'Every ticket needs a title');
      }
      if (ticket.key !== undefined && ticket.key.trim() === '') {
        return rejected('invalidCommand', `Ticket '${ticket.title}': key must not be empty`);
      }
    }
    const keys = tickets.filter((ticket) => ticket.key !== undefined).map((ticket) => ticket.key);
    if (new Set(keys).size !== keys.length) {
      return rejected('invalidCommand', 'Ticket keys must be unique');
    }
    const keySet = new Set(keys);
    const cards = this.cardsOf(found.projectId);
    for (const ticket of tickets) {
      for (const dep of ticket.blockedBy) {
        if (dep === ticket.key) {
          return rejected('invalidCommand', `Ticket '${ticket.title}': a ticket cannot block itself`);
        }
        if (!keySet.has(dep) && !cards.has(dep)) {
          return rejected(
            'invalidCommand',
            `Ticket '${ticket.title}': blockedBy entry ${dep} is neither an existing card nor a ticket key`,
          );
        }
      }
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

  private findCard(
    scope: string | undefined,
    cardId: string,
  ): { projectId: string; card: Card } | null {
    if (scope === undefined) return null;
    const card = this.cardsOf(scope).get(cardId);
    return card ? { projectId: scope, card } : null;
  }

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

  /**
   * After a move, re-evaluates the moved card's dependents and emits
   * dependencyStateChanged for those whose blocked-ness flipped (v1
   * `append_dependency_transitions`).
   */
  private async appendDependencyTransitions(
    projectId: string,
    before: Map<string, Card>,
    moved: Card,
  ): Promise<void> {
    const after = new Map(before);
    after.set(moved.id, moved);
    const pipelines = this.pipelinesOf(projectId);
    for (const dependent of before.values()) {
      if (!dependent.blockedBy.includes(moved.id)) continue;
      const was = isBlockedIn(before, dependent, pipelines);
      const now = isBlockedIn(after, dependent, pipelines);
      if (was !== now) {
        await this.bus.publish(projectId, 'dependencyStateChanged', {
          cardId: dependent.id,
          blocked: now,
          blockedBy: dependent.blockedBy,
        });
      }
    }
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
    const rejection = (message: string): CommandOutcome => rejected('invalidCommand', message);
    const name = pipeline.name.trim();
    if (name === '') {
      return rejection('Pipeline name is required');
    }
    if (pipeline.stages.length === 0) {
      return rejection('A pipeline needs at least one stage');
    }
    if (pipeline.steps.length === 0) {
      return rejection('A pipeline needs at least one step');
    }
    if (pipeline.steps.length > MAX_PIPELINE_STEPS) {
      return rejection(`Pipeline has ${pipeline.steps.length} steps; the limit is ${MAX_PIPELINE_STEPS}`);
    }

    const seenStages = new Set<string>();
    const stageOrder = new Map<string, number>();
    for (const [index, stage] of pipeline.stages.entries()) {
      const id = stage.id.trim();
      if (id === '') {
        return rejection(`Stage ${index + 1} needs an id`);
      }
      if (seenStages.has(id)) {
        return rejection(`Stage id '${id}' appears twice`);
      }
      seenStages.add(id);
      stageOrder.set(id, index);
    }
    for (const [index, stage] of normalizeStages(pipeline.stages).entries()) {
      const label = `Stage ${index + 1}`;
      if (stage.label.trim() === '') {
        return rejection(`${label} needs a label`);
      }
      for (const outcome of stage.outcomes ?? []) {
        if (outcome.outcome.trim() === '') {
          return rejection(`${label}: an outcome needs a name`);
        }
        if (outcome.toStageId !== undefined) {
          const target = stageOrder.get(outcome.toStageId);
          if (target === undefined) {
            return rejection(`${label}: outcome '${outcome.outcome}' names an unknown stage`);
          }
          if (target >= index) {
            return rejection(
              `${label}: outcome '${outcome.outcome}' may only return to an earlier stage`,
            );
          }
        }
      }
      const outcomeNames = (stage.outcomes ?? []).map((rule) => rule.outcome.trim());
      if (new Set(outcomeNames).size !== outcomeNames.length) {
        return rejection(`${label}: outcome names must be unique`);
      }
      if (stage.errorReturnToStageId !== undefined) {
        const target = stageOrder.get(stage.errorReturnToStageId);
        if (target === undefined) {
          return rejection(`${label}: the error condition names an unknown stage`);
        }
        if (target >= index) {
          return rejection(`${label}: the error condition may only return to an earlier stage`);
        }
      }
    }

    const seenSteps = new Set<string>();
    let lastOrder = -1;
    for (const [index, step] of pipeline.steps.entries()) {
      const label = `Step ${index + 1}`;
      const id = step.id.trim();
      if (id === '') {
        return rejection(`${label} needs an id`);
      }
      if (seenSteps.has(id)) {
        return rejection(`Step id '${id}' appears twice`);
      }
      seenSteps.add(id);
      const stageIndex = stageOrder.get(step.stageId);
      if (stageIndex === undefined) {
        return rejection(`${label}: stage '${step.stageId}' is not a stage of this pipeline`);
      }
      if (stageIndex < lastOrder) {
        return rejection(`${label}: the normal path must not move to an earlier stage`);
      }
      lastOrder = stageIndex;
      const message = validatePipelineStep(step);
      if (message !== null) {
        return rejection(`${label}: ${message}`);
      }
    }

    const terminals = pipeline.stages.filter((stage) => stage.terminal === true);
    if (terminals.length !== 1) {
      return rejection('A pipeline needs exactly one terminal (Done) stage');
    }
    if (pipeline.stages[pipeline.stages.length - 1]?.terminal !== true) {
      return rejection('The terminal stage must be the last stage');
    }
    if (pipeline.stages[0]?.kanbanVisible !== true) {
      return rejection('The first stage must be Kanban-visible');
    }

    const id = pipeline.id.trim() !== '' ? pipeline.id.trim() : allocateId(this.pipelinesOf(scope).keys(), 'PL');
    const current = this.pipelinesOf(scope).get(id);
    if (current !== undefined && sameDefinition(current, pipeline, name)) {
      return ok();
    }
    const saved: PipelineJson = {
      id,
      projectId: scope,
      name,
      revision: (current?.revision ?? 0) + 1,
      stages: normalizeStages(pipeline.stages),
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
    const card = this.cardsOf(scope).get(cardId);
    if (card === undefined) {
      return rejected('unknownCard', `Unknown card ${cardId}`);
    }
    const pipeline = this.pipelinesOf(scope).get(card.pipelineId);
    if (pipeline === undefined) {
      return rejected('unknownPipeline', `Card ${cardId} has no assigned pipeline`);
    }
    if (this.bus.state.projects.get(scope)?.directory === undefined) {
      return rejected('invalidCommand', `Project ${scope} has no directory set`);
    }
    if (this.activeRunOf(scope, cardId) !== null) {
      return rejected('runActive', `Card ${cardId} already has a running pipeline`);
    }
    if (pipeline.isTerminalStage(card.stageId)) {
      return rejected('invalidCommand', `Card ${cardId} is completed — reopen it to run again`);
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
    const run = this.activeRunOf(scope, cardId);
    if (run === null) {
      return rejected(
        this.findCard(scope, cardId) === null ? 'unknownCard' : 'pipelineNotRunning',
        this.findCard(scope, cardId) === null ? `Unknown card ${cardId}` : `Card ${cardId} has no running pipeline`,
      );
    }
    await this.bus.publish(scope!, 'pipelineRunEnded', {
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
    const run = this.activeRunOf(scope, cardId);
    if (run === null) {
      const unknown = this.findCard(scope, cardId) === null;
      return rejected(
        unknown ? 'unknownCard' : 'pipelineNotRunning',
        unknown ? `Unknown card ${cardId}` : `Card ${cardId} has no running pipeline`,
      );
    }
    if (run.status !== 'waiting') {
      return rejected('pipelineNotRunning', `Card ${cardId}'s pipeline is not waiting at a gate`);
    }
    await this.bus.publish(scope!, 'pipelineGateResponded', {
      runId: run.id,
      cardId,
      approved,
      ...(comment !== undefined ? { comment } : {}),
    });
    return ok();
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
    const project = this.bus.state.byProject.get(scope);
    const session = project?.agentSessions.get(sessionId);
    if (session === undefined) {
      return rejected('unknownSession', `Unknown session ${sessionId}`);
    }
    if (session.status !== 'running') {
      return rejected('invalidCommand', `Session ${sessionId} is not running`);
    }
    const cardId = session.cardId;
    const run = this.activeRunOf(scope, cardId);
    if (run === null) {
      return rejected('pipelineNotRunning', `Card ${cardId} has no running pipeline`);
    }
    if (run.stepKind !== 'agent' || run.stepId === undefined || run.stageId === undefined) {
      return rejected('invalidCommand', `Card ${cardId}'s pipeline is not at an agent step`);
    }
    // The run's pinned revision owns the stage semantics — an edited
    // pipeline never changes a live run's rules.
    const pipeline =
      project?.pipelineRevisions.get(run.pipelineId)?.get(run.revision) ??
      this.pipelinesOf(scope).get(run.pipelineId);
    const stage = pipeline?.stages.find((candidate) => candidate.id === run.stageId);
    if (pipeline === undefined || stage === undefined) {
      return rejected('unknownPipeline', `Run ${run.id} names an unknown pipeline or stage`);
    }
    const rules = stage.outcomes ?? [];
    const name = outcome.trim();
    const rule = rules.find((candidate) => candidate.outcome === name);
    if (name === '' || rule === undefined) {
      const names = rules.map((candidate) => `'${candidate.outcome}'`).join(', ');
      return rejected(
        'invalidCommand',
        names === ''
          ? `Stage ${stage.label} defines no outcomes to report`
          : `outcome '${name}' is not one of stage ${stage.label}'s outcomes: ${names}`,
      );
    }
    const trimmedNote = note?.trim();
    await this.bus.publish(scope, 'pipelineOutcomeReported', {
      runId: run.id,
      cardId,
      pipelineId: run.pipelineId,
      stepId: run.stepId,
      outcome: name,
      ...(trimmedNote !== undefined && trimmedNote !== '' ? { note: trimmedNote } : {}),
    });
    return {
      ok: true,
      transition:
        rule.toStageId !== undefined
          ? `the card returns to ${
              pipeline.stages.find((candidate) => candidate.id === rule.toStageId)?.label ?? rule.toStageId
            } when the step finishes`
          : 'the pipeline proceeds when the step finishes',
    };
  }

  // ---- Pipeline helpers ----

  private pipelinesOf(projectId: string): Map<string, Pipeline> {
    return this.bus.state.byProject.get(projectId)?.pipelines ?? new Map();
  }

  private runsOf(projectId: string): Map<string, Run> {
    return this.bus.state.byProject.get(projectId)?.runs ?? new Map();
  }

  /** The card's active run, if any (at most one). */
  private activeRunOf(projectId: string | undefined, cardId: string): Run | null {
    if (projectId === undefined) return null;
    const project = this.bus.state.byProject.get(projectId);
    const runId = project?.activeRuns.get(cardId);
    return (runId !== undefined ? project?.runs.get(runId) : undefined) ?? null;
  }

  /** The project's default pipeline: PL-1 when present, else the first by id. */
  private defaultPipelineOf(projectId: string): Pipeline | undefined {
    const pipelines = this.pipelinesOf(projectId);
    if (pipelines.size === 0) return undefined;
    if (pipelines.has(DEFAULT_PIPELINE_ID)) return pipelines.get(DEFAULT_PIPELINE_ID);
    return pipelines.get([...pipelines.keys()].sort()[0]!);
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
    const thread = this.assistantThreads().get(threadId);
    if (!thread) {
      return rejected('unknownThread', `Unknown thread ${threadId}`);
    }
    if (thread.archivedAt !== undefined) return ok();
    await this.bus.publish(undefined, 'assistantThreadArchived', {
      threadId,
      archivedAt: nowIso(),
    });
    return ok();
  }

  private async restoreAssistantThread(threadId: string): Promise<CommandOutcome> {
    const thread = this.assistantThreads().get(threadId);
    if (!thread) {
      return rejected('unknownThread', `Unknown thread ${threadId}`);
    }
    if (thread.archivedAt === undefined) return ok();
    await this.bus.publish(undefined, 'assistantThreadRestored', {
      threadId,
      restoredAt: nowIso(),
    });
    return ok();
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
    const thread = this.assistantThreads().get(threadId);
    if (!thread) {
      return rejected('unknownThread', `Unknown thread ${threadId}`);
    }
    if (thread.archivedAt !== undefined) {
      return rejected('invalidCommand', `Thread ${threadId} is archived`);
    }
    const seen = new Set<string>();
    const scoped: string[] = [];
    for (const projectId of projectIds) {
      if (projectId === '' || seen.has(projectId)) continue;
      const project = this.bus.state.projects.get(projectId);
      if (!project) {
        return rejected('unknownProject', `Unknown project ${projectId}`);
      }
      if (project.archivedAt !== undefined) {
        return rejected('invalidCommand', `Project ${projectId} is archived`);
      }
      seen.add(projectId);
      scoped.push(projectId);
    }
    await this.bus.publish(undefined, 'assistantThreadScopeChanged', {
      threadId,
      projectIds: scoped,
    });
    return ok();
  }

  /** Appends a user message to the thread (archived threads are closed). */
  private async assistantMessage(threadId: string, text: string): Promise<CommandOutcome> {
    const thread = this.assistantThreads().get(threadId);
    if (!thread) {
      return rejected('unknownThread', `Unknown thread ${threadId}`);
    }
    if (thread.archivedAt !== undefined) {
      return rejected('invalidCommand', `Thread ${threadId} is archived; restore it first`);
    }
    if (text.trim() === '') {
      return rejected('invalidCommand', 'Message text is required');
    }
    const message: ChatMessage = {
      id: randomUUID(),
      index: nextAssistantMessageIndex(thread),
      role: 'user',
      text,
      at: nowIso(),
    };
    await this.bus.publish(undefined, 'assistantUserMessage', { threadId, message });
    return ok();
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
    const thread = this.assistantThreads().get(threadId);
    if (!thread) {
      return rejected('unknownThread', `Unknown thread ${threadId}`);
    }
    if (thread.archivedAt !== undefined) {
      return rejected('invalidCommand', `Thread ${threadId} is archived; restore it first`);
    }
    if (text.trim() === '') {
      return rejected('invalidCommand', 'Message text is required');
    }
    const original = thread.messages.find((message) => message.id === messageId);
    if (original === undefined) {
      return rejected('unknownSession', `Unknown message ${messageId}`);
    }
    if (thread.status === 'running') {
      return rejected('invalidCommand', `Thread ${threadId} is already running`);
    }
    if (original.role !== 'user') {
      return rejected('invalidCommand', 'Only a user message can be edited and resent');
    }
    const message: ChatMessage = {
      id: randomUUID(),
      ...(original.parentId !== undefined ? { parentId: original.parentId } : {}),
      index: nextAssistantMessageIndex(thread),
      role: 'user',
      text,
      at: nowIso(),
    };
    await this.bus.publish(undefined, 'assistantResent', { threadId, message });
    return ok();
  }

  // ---- Work proposals (Phase 8) ----

  private static readonly MAX_PROPOSAL_ITEMS = 50;

  /**
   * Records the assistant's draft (the propose_cards MCP tool lands here).
   * Everything is validated up front — scope, shape, and dependencies — so
   * the tool result can teach the model before the user ever sees it.
   */
  private async draftProposal(threadId: string, items: ProposalItem[]): Promise<CommandOutcome> {
    const thread = this.assistantThreads().get(threadId);
    if (!thread) {
      return rejected('unknownThread', `Unknown thread ${threadId}`);
    }
    if (thread.archivedAt !== undefined) {
      return rejected('invalidCommand', `Thread ${threadId} is archived; restore it first`);
    }
    if (items.length === 0) {
      return rejected('invalidCommand', 'No proposal items provided');
    }
    if (items.length > Processor.MAX_PROPOSAL_ITEMS) {
      return rejected('invalidCommand', `A proposal carries at most ${Processor.MAX_PROPOSAL_ITEMS} items`);
    }
    const keys = items.filter((item) => item.key !== undefined).map((item) => item.key!);
    if (new Set(keys).size !== keys.length) {
      return rejected('invalidCommand', 'Proposal item keys must be unique');
    }
    const keySet = new Set(keys);
    for (const item of items) {
      if (!thread.projectIds.includes(item.projectId)) {
        return rejected('invalidCommand', `project ${item.projectId} is not in thread ${threadId}'s scope`);
      }
      const error = validateProposalItem(item, this.cardsOf(item.projectId), keySet);
      if (error !== null) return rejected('invalidCommand', error);
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
    if (proposal.status !== 'drafted') {
      return rejected('invalidCommand', `Proposal ${proposalId} was already ${proposal.status}`);
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
    if (proposal.status !== 'drafted') {
      return rejected('invalidCommand', `Proposal ${proposalId} was already ${proposal.status}`);
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
    const thread = this.assistantThreads().get(threadId);
    if (!thread) {
      return rejected('unknownThread', `Unknown thread ${threadId}`);
    }
    if (thread.status !== 'running') {
      return rejected('invalidCommand', `Thread ${threadId} is not running`);
    }
    await this.bus.publish(undefined, 'assistantThreadStopped', { threadId });
    return ok();
  }

  /**
   * Re-runs the thread's last user message (Phase 7): the reply appends an
   * alternate response — nothing in the transcript is rewritten.
   */
  private async retryAssistantThread(threadId: string): Promise<CommandOutcome> {
    const thread = this.assistantThreads().get(threadId);
    if (!thread) {
      return rejected('unknownThread', `Unknown thread ${threadId}`);
    }
    if (thread.archivedAt !== undefined) {
      return rejected('invalidCommand', `Thread ${threadId} is archived; restore it first`);
    }
    if (thread.status === 'running') {
      return rejected('invalidCommand', `Thread ${threadId} is already running`);
    }
    const lastUser = [...thread.messages].reverse().find((message) => message.role === 'user');
    if (lastUser === undefined) {
      return rejected('invalidCommand', `Thread ${threadId} has no user message to retry`);
    }
    await this.bus.publish(undefined, 'assistantRetryRequested', { threadId });
    return ok();
  }

  private async renameAssistantThread(threadId: string, name: string): Promise<CommandOutcome> {
    const thread = this.assistantThreads().get(threadId);
    if (!thread) {
      return rejected('unknownThread', `Unknown thread ${threadId}`);
    }
    if (thread.archivedAt !== undefined) {
      return rejected('invalidCommand', `Thread ${threadId} is archived; restore it first`);
    }
    const trimmed = name.trim();
    if (trimmed === '') {
      return rejected('invalidCommand', 'Thread name is required');
    }
    if (trimmed === thread.name) return ok();
    await this.bus.publish(undefined, 'assistantThreadRenamed', { threadId, name: trimmed });
    return ok();
  }
}

function ok(): CommandOutcome {
  return { ok: true };
}

function rejected(code: Rejection['code'], message: string): CommandOutcome {
  return { ok: false, rejection: { code, message } };
}

/** Fills the stage defaults the lenient wire allows (visibility, trimmed labels). */
function normalizeStages(stages: readonly PipelineStage[]): PipelineStage[] {
  return stages.map((stage) => ({
    id: stage.id.trim(),
    label: stage.label.trim(),
    kanbanVisible: stage.kanbanVisible !== false,
    ...(stage.terminal === true ? { terminal: true } : {}),
    ...(stage.outcomes !== undefined && stage.outcomes.length > 0
      ? {
          outcomes: stage.outcomes.map((rule) => ({
            outcome: rule.outcome.trim(),
            ...(rule.toStageId !== undefined && rule.toStageId.trim() !== ''
              ? { toStageId: rule.toStageId.trim() }
              : {}),
          })),
        }
      : {}),
    ...(stage.requiresOutcome === true ? { requiresOutcome: true } : {}),
    ...(stage.errorReturnToStageId !== undefined && stage.errorReturnToStageId.trim() !== ''
      ? { errorReturnToStageId: stage.errorReturnToStageId.trim() }
      : {}),
  }));
}

/** Whether a save would change the definition (name, stages, or steps). */
function sameDefinition(current: Pipeline, next: PipelineJson, name: string): boolean {
  return (
    current.name === name &&
    JSON.stringify(normalizeStages(current.stages)) === JSON.stringify(normalizeStages(next.stages)) &&
    JSON.stringify(current.steps) === JSON.stringify(next.steps)
  );
}

/** A timestamp the client actually set (v1's DEFAULT_TIMESTAMP sentinel → absent here). */
function isSet(timestamp: string): boolean {
  return timestamp !== '' && Date.parse(timestamp) > 0;
}

/** One past the highest message index (v1 `next_message_index`; starts at 1). */
function nextMessageIndex(session: PlanningSession): number {
  return session.messages.reduce((max, message) => Math.max(max, message.index), 0) + 1;
}

/** One past the highest assistant message index. */
function nextAssistantMessageIndex(thread: AssistantThread): number {
  return thread.messages.reduce((max, message) => Math.max(max, message.index), 0) + 1;
}

/**
 * One proposal item's domain validation: shape, key self-reference, and
 * deps that must name an in-batch key or an existing card of the item's
 * target project (missing blockers don't block — unknown ones reject).
 */
function validateProposalItem(
  item: ProposalItem,
  projectCards: Map<string, Card>,
  keySet: Set<string>,
): string | null {
  if (item.title.trim() === '') {
    return `Proposal item '${item.title || item.projectId}': a title is required`;
  }
  if (item.cardType !== 'coding' && item.cardType !== 'design' && item.cardType !== 'docs') {
    return `Proposal item '${item.title}': card type must be coding, design, or docs`;
  }
  if (item.key !== undefined && item.key.trim() === '') {
    return `Proposal item '${item.title}': key must not be empty`;
  }
  for (const dep of item.blockedBy) {
    if (dep === item.key) {
      return `Proposal item '${item.title}': a proposal item cannot block itself`;
    }
    if (!keySet.has(dep) && !projectCards.has(dep)) {
      return `Proposal item '${item.title}': blockedBy entry ${dep} is neither an existing card nor a proposal key`;
    }
  }
  return null;
}

/** The per-kind fields a pipeline step must carry (v1 M3). */
function validatePipelineStep(step: PipelineStep): string | null {
  switch (step.kind) {
    case 'agent':
      if (step.agentKind === undefined || step.agentKind === '') {
        return 'an agent step needs an agentKind';
      }
      if (step.instructions === undefined || step.instructions.trim() === '') {
        return 'an agent step needs instructions';
      }
      return null;
    case 'command':
      if (step.command === undefined || step.command.trim() === '') {
        return 'a command step needs a command';
      }
      return null;
    case 'human':
      if (step.description === undefined || step.description.trim() === '') {
        return 'a human step needs a description (the approval prompt)';
      }
      return null;
  }
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
