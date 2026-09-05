// Command validation → canonical events (v1 architecture.md §Server
// command validation). Same validation order, same rejection messages, and
// the same emitted event lists as v1 for the domains v2 keeps. Human drags
// are never blocked by automation toggles.

import { statSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import type { Bus } from './bus.js';
import type { Command, CommandOutcome, Rejection, TicketEmission } from './wire/commands.js';
import { nowIso } from './wire/envelope.js';
import {
  cardTypeCsName,
  isLaneValid,
  stageCsName,
  subStateFor,
  type Assignee,
  type Card,
  type CardType,
  type ChatMessage,
  type Pipeline,
  type PipelineStep,
  type PlanningSession,
  type Project,
  type Stage,
  type SubStateStatus,
} from './wire/models.js';
import type { PipelineRunProgress } from './fold.js';
import { defaultPipeline } from './pipelines.js';

/** Ceiling on steps one pipeline may carry (v1 M3). */
const MAX_PIPELINE_STEPS = 64;

/** The agent kinds the runner implements (v1 M3: the coder). */
const IMPLEMENTED_AGENT_KINDS = ['coder'];

export class Processor {
  private bus: Bus;

  constructor(bus: Bus) {
    this.bus = bus;
  }

  /**
   * Validates a command in the given project scope and, on success,
   * publishes the canonical events (persisted, folded, fanned out) before
   * resolving. S0 handles the project domain; the rest join per slice.
   */
  async execute(projectId: string | undefined, command: Command): Promise<CommandOutcome> {
    switch (command.type) {
      case 'requestProjectCreate':
        return this.createProject(command.name, command.directory);
      case 'requestProjectSetDirectory':
        return this.setProjectDirectory(projectId, command.projectId, command.directory);
      case 'requestProjectActivate':
        return this.activateProject(command.projectId);
      case 'requestCardCreate':
        return this.createCards(projectId, [command.card]);
      case 'requestCardsCreate':
        return this.createCards(projectId, command.cards);
      case 'requestCardMove':
        return this.moveCard(projectId, command.cardId, command.toLane, command.override, command.comment);
      case 'requestCardTypeChange':
        return this.changeCardType(projectId, command.cardId, command.toType);
      case 'requestCardAssign':
        return this.assignCard(projectId, command.cardId, command.assignee);
      case 'requestCardArchive':
        return this.archiveCard(projectId, command.cardId);
      case 'requestSubStateUpdate':
        return this.updateSubState(projectId, command.cardId, command.stage, command.status);
      case 'requestAutomationToggle':
        return this.toggleAutomation(projectId, command.lane, command.on);
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
        return this.runPipeline(projectId, command.pipelineId, command.cardId);
      case 'requestPipelineStop':
        return this.stopPipeline(projectId, command.cardId);
      case 'requestPipelineGateRespond':
        return this.gateRespond(projectId, command.cardId, command.approved, command.comment);
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

  // ---- Cards ----

  /**
   * Creates one or more cards (v1 `create_cards`): the scope must exist and
   * every `blockedBy` must reference a card that exists at command time
   * (in-batch cross-references are planner-ticket territory, not this).
   * Events publish per card, so each allocation sees the previous one.
   */
  private async createCards(scope: string | undefined, cards: Card[]): Promise<CommandOutcome> {
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
      const created: Card = {
        ...card,
        id: card.id !== '' ? card.id : this.allocateCardId(scope),
        projectId: scope,
        subState: Object.keys(card.subState).length > 0 ? card.subState : subStateFor(card.type),
        createdAt: isSet(card.createdAt) ? card.createdAt : now,
        updatedAt: now,
      };
      existing.set(created.id, created);
      await this.bus.publish(scope, 'cardCreated', { card: created });
      if (isBlockedIn(existing, created)) {
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
   * Moves a card (v1 `move_card`): lane must be valid for the type, the
   * same lane is a no-op, and unsatisfied blockers reject unless
   * overridden. Dependents whose blocked-ness flips get a
   * dependencyStateChanged.
   */
  private async moveCard(
    scope: string | undefined,
    cardId: string,
    toLane: Stage,
    override: boolean,
    comment: string | undefined,
  ): Promise<CommandOutcome> {
    const found = this.findCard(scope, cardId);
    if (!found) {
      return rejected('unknownCard', `Unknown card ${cardId}`);
    }
    const { projectId, card } = found;
    if (!isLaneValid(card.type, toLane)) {
      return rejected(
        'invalidLane',
        `Lane ${stageCsName(toLane)} is not valid for ${cardTypeCsName(card.type)} cards`,
      );
    }
    if (card.stage === toLane) {
      return ok();
    }
    const before = this.cardsOf(projectId);
    if (!override && isBlockedIn(before, card)) {
      return rejected('blocked', `Card ${cardId} has unsatisfied blockers`);
    }

    await this.bus.publish(projectId, 'cardMoved', {
      cardId: card.id,
      from: card.stage,
      to: toLane,
      ...(comment !== undefined ? { comment } : {}),
    });
    const moved: Card = { ...card, stage: toLane };
    await this.appendDependencyTransitions(projectId, before, moved);
    return ok();
  }

  /** Changes a card's type (v1 `change_card_type`); the fold resets sub-state. */
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

  /** Updates one sub-state key (v1 `update_sub_state`); unvalidated passthrough. */
  private async updateSubState(
    scope: string | undefined,
    cardId: string,
    stage: string,
    status: SubStateStatus,
  ): Promise<CommandOutcome> {
    const found = this.findCard(scope, cardId);
    if (!found) {
      return rejected('unknownCard', `Unknown card ${cardId}`);
    }
    await this.bus.publish(found.projectId, 'subStateUpdated', {
      cardId: found.card.id,
      stage,
      status,
    });
    return ok();
  }

  /** Toggles a lane's automation (v1 `toggle_automation`); per project. */
  private async toggleAutomation(
    scope: string | undefined,
    lane: Stage,
    on: boolean,
  ): Promise<CommandOutcome> {
    if (scope === undefined || !this.bus.state.projects.has(scope)) {
      return rejected('unknownProject', `Unknown project ${scope ?? ''}`);
    }
    await this.bus.publish(scope, 'automationToggled', { lane, on });
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

    const now = nowIso();
    const emitted: Card[] = tickets.map((ticket, offset) => ({
      id: ids[offset]!,
      projectId: found.projectId,
      type: ticket.cardType,
      title: ticket.title,
      description: ticket.description,
      tags: [],
      stage: 'new',
      blockedBy: ticket.blockedBy.map((dep) => cardIdByKey.get(dep) ?? dep),
      subState: subStateFor(ticket.cardType),
      retries: {},
      sessionId: found.session.id,
      createdAt: now,
      updatedAt: now,
    }));

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

  private cardsOf(projectId: string): Map<string, Card> {
    const cards = this.bus.state.byProject.get(projectId)?.cards;
    const copy = new Map<string, Card>();
    for (const [id, card] of cards ?? []) {
      copy.set(id, structuredClone(card));
    }
    return copy;
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
    for (const dependent of before.values()) {
      if (!dependent.blockedBy.includes(moved.id)) continue;
      const was = isBlockedIn(before, dependent);
      const now = isBlockedIn(after, dependent);
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
   * Saves a user-authored pipeline (v1 `save_pipeline`): an empty id
   * allocates the next `PL-N`, a known id upserts. A pipeline that can
   * never run is rejected here, before any event exists.
   */
  private async savePipeline(scope: string | undefined, pipeline: Pipeline): Promise<CommandOutcome> {
    if (scope === undefined || !this.bus.state.projects.has(scope)) {
      return rejected('unknownProject', `Unknown project ${scope ?? ''}`);
    }
    const rejection = (message: string): CommandOutcome => rejected('invalidCommand', message);
    const name = pipeline.name.trim();
    if (name === '') {
      return rejection('Pipeline name is required');
    }
    if (pipeline.steps.length === 0) {
      return rejection('A pipeline needs at least one step');
    }
    if (pipeline.steps.length > MAX_PIPELINE_STEPS) {
      return rejection(`Pipeline has ${pipeline.steps.length} steps; the limit is ${MAX_PIPELINE_STEPS}`);
    }
    const seen = new Set<string>();
    for (const [index, step] of pipeline.steps.entries()) {
      const label = `Step ${index + 1}`;
      const id = step.id.trim();
      if (id === '') {
        return rejection(`${label} needs an id`);
      }
      if (seen.has(id)) {
        return rejection(`Step id '${id}' appears twice`);
      }
      seen.add(id);
      const message = validatePipelineStep(step);
      if (message !== null) {
        return rejection(`${label}: ${message}`);
      }
    }
    const id = pipeline.id.trim() !== '' ? pipeline.id.trim() : allocateId(this.pipelinesOf(scope).keys(), 'PL');
    const saved: Pipeline = {
      id,
      projectId: scope,
      name,
      steps: pipeline.steps,
      updatedAt: nowIso(),
    };
    await this.bus.publish(scope, 'pipelineSaved', { pipeline: saved });
    return ok();
  }

  /**
   * Deletes a user-authored pipeline (v1 `delete_pipeline`): the
   * tombstone keeps the boot seed from resurrecting the default.
   */
  private async deletePipeline(scope: string | undefined, pipelineId: string): Promise<CommandOutcome> {
    if (scope === undefined || !this.pipelinesOf(scope).has(pipelineId)) {
      return rejected('unknownPipeline', `Unknown pipeline ${pipelineId}`);
    }
    await this.bus.publish(scope, 'pipelineDeleted', { pipelineId });
    return ok();
  }

  /**
   * Runs a pipeline on a card (v1 `run_pipeline`): the validated event is
   * the runner's trigger.
   */
  private async runPipeline(
    scope: string | undefined,
    pipelineId: string,
    cardId: string,
  ): Promise<CommandOutcome> {
    if (scope === undefined || !this.bus.state.projects.has(scope)) {
      return rejected('unknownProject', `Unknown project ${scope ?? ''}`);
    }
    if (!this.pipelinesOf(scope).has(pipelineId)) {
      return rejected('unknownPipeline', `Unknown pipeline ${pipelineId}`);
    }
    if (!this.cardsOf(scope).has(cardId)) {
      return rejected('unknownCard', `Unknown card ${cardId}`);
    }
    if (this.bus.state.projects.get(scope)?.directory === undefined) {
      return rejected('invalidCommand', `Project ${scope} has no directory set`);
    }
    if (this.bus.state.byProject.get(scope)?.pipelineRuns.has(cardId)) {
      return rejected('pipelineAlreadyRunning', `Card ${cardId} already has a running pipeline`);
    }
    const pipeline = this.pipelinesOf(scope).get(pipelineId)!;
    const kind = pipeline.steps.find((step) => step.kind === 'agent')?.agentKind;
    if (kind !== undefined && !IMPLEMENTED_AGENT_KINDS.includes(kind)) {
      return rejected('unknownAgentKind', `Agent kind '${kind}' has no implementation yet`);
    }

    await this.bus.publish(scope, 'pipelineRunStarted', { cardId, pipelineId });
    return ok();
  }

  /**
   * Stops a card's active run (v1 `stop_pipeline`): the event is the
   * canonical record and the runner's kill trigger.
   */
  private async stopPipeline(scope: string | undefined, cardId: string): Promise<CommandOutcome> {
    const run = this.runOf(scope, cardId);
    if (run === null) {
      return rejected(
        this.findCard(scope, cardId) === null ? 'unknownCard' : 'pipelineNotRunning',
        this.findCard(scope, cardId) === null ? `Unknown card ${cardId}` : `Card ${cardId} has no running pipeline`,
      );
    }
    await this.bus.publish(scope!, 'pipelineRunEnded', {
      cardId,
      pipelineId: run.pipelineId,
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
    const run = this.runOf(scope, cardId);
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
      cardId,
      approved,
      ...(comment !== undefined ? { comment } : {}),
    });
    return ok();
  }

  // ---- Pipeline helpers ----

  private pipelinesOf(projectId: string): Map<string, Pipeline> {
    return this.bus.state.byProject.get(projectId)?.pipelines ?? new Map();
  }

  private runOf(
    scope: string | undefined,
    cardId: string,
  ): PipelineRunProgress | null {
    if (scope === undefined) return null;
    const run = this.bus.state.byProject.get(scope)?.pipelineRuns.get(cardId);
    return run ?? null;
  }
}

function ok(): CommandOutcome {
  return { ok: true };
}

function rejected(code: Rejection['code'], message: string): CommandOutcome {
  return { ok: false, rejection: { code, message } };
}

/** Blocked while any blocker exists and is not done (missing blockers don't block). */
function isBlockedIn(cardsById: Map<string, Card>, card: Card): boolean {
  return card.blockedBy.some((id) => {
    const blocker = cardsById.get(id);
    return blocker !== undefined && blocker.stage !== 'done';
  });
}

/** A timestamp the client actually set (v1's DEFAULT_TIMESTAMP sentinel → absent here). */
function isSet(timestamp: string): boolean {
  return timestamp !== '' && Date.parse(timestamp) > 0;
}

/** One past the highest message index (v1 `next_message_index`; starts at 1). */
function nextMessageIndex(session: PlanningSession): number {
  return session.messages.reduce((max, message) => Math.max(max, message.index), 0) + 1;
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
