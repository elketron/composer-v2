// The planning commands (v1 planner route): opening a session, the user
// message, the plan document, and the ticket emission — the session's own
// rules (drafting guard, index allocation, ticket validation) live on the
// Planning object; these handlers resolve and publish.

import { nowIso } from '../wire/envelope.js';
import type { ChatMessage, PlanningSession } from '../wire/models.js';
import type { CommandOutcome, TicketEmission } from '../wire/commands.js';
import { Planning } from '../domain/planning.js';
import { allocateCardIds, materializeCards, publishCardBatch } from './card-batch.js';
import { command, allocateId, ok, rejected, toRejection, type CommandMap } from './helpers.js';
import type { Processor } from './index.js';

  /** Opens a planning session (v1 `create_session`); the command names the project. */

export async function createPlanningSession(p: Processor, projectId: string): Promise<CommandOutcome> {
    if (!p.bus.state.projects.has(projectId)) {
      return rejected('unknownProject', `Unknown project ${projectId}`);
    }
    const session: PlanningSession = {
      id: allocateId(p.sessionsOf(projectId).keys(), 'S'),
      projectId,
      createdAt: nowIso(),
      status: 'drafting',
      messages: [],
      planDocument: '',
    };
    await p.bus.publish(projectId, 'planningSessionCreated', { session });
    return ok();
  }

  /** Appends a user message (v1 `user_message`); drafting sessions only. */


  /** Appends a user message (v1 `user_message`); drafting sessions only. */

export async function userMessage(
    p: Processor,
    scope: string | undefined,
    sessionId: string,
    text: string,
  ): Promise<CommandOutcome> {
    const found = p.findSession(scope, sessionId);
    if (!found) {
      return rejected('unknownSession', `Unknown session ${sessionId}`);
    }
    let message: ChatMessage;
    try {
      message = Planning.of(found.session).userMessage(text);
    } catch (error) {
      return toRejection(error);
    }
    await p.bus.publish(found.projectId, 'userMessageReceived', {
      sessionId: found.session.id,
      message,
    });
    return ok();
  }

  /** Replaces the plan document wholesale (v1 `update_plan_document`). */


  /** Replaces the plan document wholesale (v1 `update_plan_document`). */

export async function updatePlanDocument(
    p: Processor,
    scope: string | undefined,
    sessionId: string,
    document: string,
  ): Promise<CommandOutcome> {
    const found = p.findSession(scope, sessionId);
    if (!found) {
      return rejected('unknownSession', `Unknown session ${sessionId}`);
    }
    try {
      Planning.of(found.session).requireDocumentOpen();
    } catch (error) {
      return toRejection(error);
    }
    await p.bus.publish(found.projectId, 'planDocumentUpdated', {
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


  /**
   * Emits the planner's tickets as cards (v1 `create_tickets`): in-batch
   * keys remap onto the freshly assigned card ids, `blockedBy` entries must
   * name an existing card or another ticket's key (never the ticket
   * itself), and the session closes.
   */

export async function createTickets(
    p: Processor,
    scope: string | undefined,
    sessionId: string,
    tickets: TicketEmission[],
  ): Promise<CommandOutcome> {
    const found = p.findSession(scope, sessionId);
    if (!found) {
      return rejected('unknownSession', `Unknown session ${sessionId}`);
    }
    const cards = p.cardsOf(found.projectId);
    try {
      Planning.of(found.session).requireDrafting('its tickets were already emitted');
      Planning.validateTickets(tickets, cards);
    } catch (error) {
      return toRejection(error);
    }

    const pipeline = p.defaultPipelineOf(found.projectId);
    if (pipeline === undefined) {
      return rejected('invalidCommand', `Project ${found.projectId} has no pipeline to assign the tickets to`);
    }
    const ids = allocateCardIds(cards, tickets.length);
    const emitted = materializeCards(tickets, {
      projectId: found.projectId,
      ids,
      pipeline,
      now: nowIso(),
      sessionId: found.session.id,
    });
    await publishCardBatch(p.bus, found.projectId, emitted);
    await p.bus.publish(found.projectId, 'planningSessionCompleted', {
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


export const planningCommands: CommandMap = [
  command('requestPlanningSessionCreate', (p, _scope, cmd) => createPlanningSession(p, cmd.projectId)),
  command('requestUserMessage', (p, scope, cmd) => userMessage(p, scope, cmd.sessionId, cmd.text)),
  command('requestPlanDocumentUpdate', (p, scope, cmd) => updatePlanDocument(p, scope, cmd.sessionId, cmd.document)),
  command('requestTicketsCreate', (p, scope, cmd) => createTickets(p, scope, cmd.sessionId, cmd.tickets)),
];
