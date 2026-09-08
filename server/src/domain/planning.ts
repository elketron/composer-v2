// The planning session's transitions: a drafting session owns its
// transcript and plan document — both close when the session is done —
// and validates the planner's ticket emission before the cards commit.

import type { Card as CardJson, ChatMessage, PlanningSession } from '../wire/models.js';
import type { TicketEmission } from '../wire/commands.js';
import { CommandRejection } from './rejection.js';
import type { Clock } from './ports.js';

export class Planning {
  private constructor(private readonly session: PlanningSession) {}

  static of(session: PlanningSession): Planning {
    return new Planning(session);
  }

  /** A done session's transcript/document/tickets are closed (each tells its own story). */
  requireDrafting(what: string): void {
    if (this.session.status !== 'drafting') {
      throw new CommandRejection('invalidCommand', `Session ${this.session.id} is done; ${what}`);
    }
  }

  /** Appends a user message (v1 `user_message`); drafting sessions only. */
  userMessage(text: string, clock: Clock): ChatMessage {
    this.requireDrafting('its transcript is closed');
    if (text.trim() === '') {
      throw new CommandRejection('invalidCommand', 'Message text is required');
    }
    return {
      index: this.nextMessageIndex(),
      role: 'user',
      text,
      at: clock(),
    };
  }

  /** Replaces the plan document wholesale (v1 `update_plan_document`). */
  requireDocumentOpen(): void {
    this.requireDrafting('its plan document is closed');
  }

  /** One past the highest message index (v1 `next_message_index`; starts at 1). */
  nextMessageIndex(): number {
    return this.session.messages.reduce((max, message) => Math.max(max, message.index), 0) + 1;
  }

  /**
   * Emits the planner's tickets (v1 `create_tickets`): every ticket needs
   * a title, keys must be unique and non-empty, and each `blockedBy` entry
   * must name an existing card or another ticket's key (never the ticket
   * itself).
   */
  static validateTickets(tickets: TicketEmission[], cards: ReadonlyMap<string, CardJson>): void {
    if (tickets.length === 0) {
      throw new CommandRejection('invalidCommand', 'No tickets provided');
    }
    for (const ticket of tickets) {
      if (ticket.title.trim() === '') {
        throw new CommandRejection('invalidCommand', 'Every ticket needs a title');
      }
      if (ticket.key !== undefined && ticket.key.trim() === '') {
        throw new CommandRejection('invalidCommand', `Ticket '${ticket.title}': key must not be empty`);
      }
    }
    const keys = tickets.filter((ticket) => ticket.key !== undefined).map((ticket) => ticket.key);
    if (new Set(keys).size !== keys.length) {
      throw new CommandRejection('invalidCommand', 'Ticket keys must be unique');
    }
    const keySet = new Set(keys);
    for (const ticket of tickets) {
      for (const dep of ticket.blockedBy) {
        if (dep === ticket.key) {
          throw new CommandRejection('invalidCommand', `Ticket '${ticket.title}': a ticket cannot block itself`);
        }
        if (!keySet.has(dep) && !cards.has(dep)) {
          throw new CommandRejection(
            'invalidCommand',
            `Ticket '${ticket.title}': blockedBy entry ${dep} is neither an existing card nor a ticket key`,
          );
        }
      }
    }
  }
}
