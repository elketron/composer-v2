// The work-proposal commands (Phase 8): the assistant's draft lands
// validated up front; confirmation re-validates against current state and
// lands the included items as one independent batch per target project
// through the same card-creation rules; discard is a tombstone.

import { randomUUID } from 'node:crypto';
import { nowIso } from '../wire/envelope.js';
import type { CommandOutcome } from '../wire/commands.js';
import { CommandRejection } from '../domain/rejection.js';
import type { CardProposal, ProposalItem, ProposalOutcome } from '../wire/models.js';
import { Card } from '../domain/card.js';
import { Proposal, validateProposalItem } from '../domain/proposal.js';
import { Thread } from '../domain/thread.js';
import { command, allocateId, ok, rejected, toRejection, type CommandMap } from './helpers.js';
import type { Processor } from './index.js';
import { findThread } from './threads.js';

const MAX_PROPOSAL_ITEMS = 50;

  /**
   * Records the assistant's draft (the propose_cards MCP tool lands here).
   * Everything is validated up front — scope, shape, and dependencies — so
   * the tool result can teach the model before the user ever sees it.
   */

export async function draftProposal(p: Processor, threadId: string, items: ProposalItem[]): Promise<CommandOutcome> {
    const found = findThread(p, threadId);
    if (!found) {
      return rejected('unknownThread', `Unknown thread ${threadId}`);
    }
    const thread = Thread.of(found);
    try {
      thread.requireOpen();
      if (items.length === 0) {
        throw new CommandRejection('invalidCommand', 'No proposal items provided');
      }
      if (items.length > MAX_PROPOSAL_ITEMS) {
        throw new CommandRejection('invalidCommand', `A proposal carries at most ${MAX_PROPOSAL_ITEMS} items`);
      }
      const keys = items.filter((item) => item.key !== undefined).map((item) => item.key!);
      if (new Set(keys).size !== keys.length) {
        throw new CommandRejection('invalidCommand', 'Proposal item keys must be unique');
      }
      const keySet = new Set(keys);
      for (const item of items) {
        thread.requireInScope(item.projectId);
        const error = validateProposalItem(item, p.cardsOf(item.projectId), keySet);
        if (error !== null) throw new CommandRejection('invalidCommand', error);
      }
    } catch (error) {
      return toRejection(error);
    }

    const proposal: CardProposal = {
      id: allocateId(p.bus.state.proposals.keys(), 'PR'),
      threadId,
      createdAt: nowIso(),
      status: 'drafted',
      items: items.map((item) => ({
        ...item,
        id: randomUUID(),
        included: true,
      })),
    };
    await p.bus.publish(undefined, 'proposalDrafted', { proposal });
    return ok();
  }

  /**
   * Confirms a proposal: the (possibly edited) items land as cards through
   * the validated processor, as one independent batch per target project —
   * a project that fails validation reports an explicit error while the
   * others proceed. Everything is re-validated against current state.
   */


  /**
   * Confirms a proposal: the (possibly edited) items land as cards through
   * the validated processor, as one independent batch per target project —
   * a project that fails validation reports an explicit error while the
   * others proceed. Everything is re-validated against current state.
   */

export async function confirmProposal(p: Processor, proposalId: string, items: ProposalItem[]): Promise<CommandOutcome> {
    const proposal = p.bus.state.proposals.get(proposalId);
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
      if (!p.bus.state.projects.has(item.projectId)) {
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
        const error = validateProposalItem(item, p.cardsOf(projectId), keySet);
        if (error !== null) {
          rejection = error;
          break;
        }
      }

      if (rejection !== null) {
        outcomes.push({ projectId, ok: false, error: rejection });
        continue;
      }

      const cards = p.cardsOf(projectId);
      const first = Number(allocateId(cards.keys(), 'T').slice(2));
      const ids: string[] = batch.map((_, offset) => `T-${first + offset}`);
      const cardIdByKey = new Map<string, string>();
      batch.forEach((item, offset) => {
        if (item.key !== undefined) cardIdByKey.set(item.key, ids[offset]!);
      });
      const pipeline = p.defaultPipelineOf(projectId);
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
      await p.bus.publish(projectId, 'cardsCommitted', { cards: created });
      for (const card of created) {
        if (card.blockedBy.length === 0) continue;
        await p.bus.publish(projectId, 'dependencyStateChanged', {
          cardId: card.id,
          blocked: true,
          blockedBy: card.blockedBy,
        });
      }
      outcomes.push({ projectId, ok: true, cardIds: ids });
    }

    await p.bus.publish(undefined, 'proposalConfirmed', {
      proposalId,
      items,
      outcomes,
      confirmedAt: nowIso(),
    });
    return ok();
  }


export async function discardProposal(p: Processor, proposalId: string): Promise<CommandOutcome> {
    const proposal = p.bus.state.proposals.get(proposalId);
    if (!proposal) {
      return rejected('unknownProposal', `Unknown proposal ${proposalId}`);
    }
    try {
      Proposal.of(proposal).requireDrafted();
    } catch (error) {
      return toRejection(error);
    }
    await p.bus.publish(undefined, 'proposalDiscarded', { proposalId });
    return ok();
  }

  // ---- Docs (Phase 9): validated writes over the project's docs/ files ----

  /** Creates or overwrites one doc; the event carries metadata only. */


export const proposalCommands: CommandMap = [
  command('requestProposalDraft', (p, _scope, cmd) => draftProposal(p, cmd.threadId, cmd.items)),
  command('requestProposalConfirm', (p, _scope, cmd) => confirmProposal(p, cmd.proposalId, cmd.items)),
  command('requestProposalDiscard', (p, _scope, cmd) => discardProposal(p, cmd.proposalId)),
];
