// The work proposal's transitions: a drafted proposal is the only one that
// confirms or discards, and each item validates against its target
// project's cards — shape, key self-reference, and deps that must name an
// in-batch key or an existing card (missing blockers don't block; unknown
// ones reject).

import type { Card as CardJson, CardProposal, ProposalItem } from '../wire/models.js';
import { readString, readStringArray, asRecord } from '../wire/read.js';
import { CommandRejection } from './rejection.js';

export class Proposal {
  private constructor(private readonly proposal: CardProposal) {}

  static of(proposal: CardProposal): Proposal {
    return new Proposal(proposal);
  }

  /** Confirmation and discard land on a drafted proposal only. */
  requireDrafted(): void {
    if (this.proposal.status !== 'drafted') {
      throw new CommandRejection('invalidCommand', `Proposal ${this.proposal.id} was already ${this.proposal.status}`);
    }
  }
}

/**
 * The proposal item the client meant — defaults where absent (Phase 8).
 */
export function proposalItemFromAction(json: unknown): ProposalItem {
  const record = asRecord(json);
  const cardType = readString(record, 'cardType');
  const key = readString(record, 'key');
  return {
    id: readString(record, 'id') ?? '',
    projectId: readString(record, 'projectId') ?? '',
    title: readString(record, 'title') ?? '',
    description: readString(record, 'description') ?? '',
    cardType: cardType === 'design' || cardType === 'docs' ? cardType : 'coding',
    ...(key !== undefined && key !== '' ? { key } : {}),
    blockedBy: readStringArray(record, 'blockedBy'),
    included: record['included'] !== false,
  };
}

/**
 * One proposal item's domain validation (shared by draft and confirm —
 * confirm re-validates against current state).
 */
export function validateProposalItem(
  item: ProposalItem,
  projectCards: ReadonlyMap<string, CardJson>,
  keySet: ReadonlySet<string>,
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
