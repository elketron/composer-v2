// The work-proposal domain's fold steps (Phase 8): the draft, the
// confirmation (edited items + per-project batch outcomes), and the
// discard.

import { readBody, type FoldHandler } from './state.js';

export const proposalHandlers: Record<string, FoldHandler> = {
  proposalDrafted: (state, envelope) => {
    const body = readBody(envelope, 'proposalDrafted');
    state.proposals.set(body.proposal.id, structuredClone(body.proposal));
  },
  proposalConfirmed: (state, envelope) => {
    const body = readBody(envelope, 'proposalConfirmed');
    const proposal = state.proposals.get(body.proposalId);
    if (!proposal) return;
    proposal.items = structuredClone(body.items);
    proposal.outcomes = structuredClone(body.outcomes);
    proposal.status = 'confirmed';
    proposal.confirmedAt = body.confirmedAt;
  },
  proposalDiscarded: (state, envelope) => {
    const body = readBody(envelope, 'proposalDiscarded');
    const proposal = state.proposals.get(body.proposalId);
    if (proposal) proposal.status = 'discarded';
  },
};
