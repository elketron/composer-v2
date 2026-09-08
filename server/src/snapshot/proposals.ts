// The work proposals' snapshot appender (Phase 8): the creation event
// carries the folded record (status, possibly edited items, batch
// outcomes).

import type { CardProposal } from '../wire/models.js';
import type { FrameEmitter } from './emit.js';

export function appendProposals(emit: FrameEmitter, proposals: Map<string, CardProposal>): void {
  for (const proposal of [...proposals.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )) {
    emit(undefined, 'proposalDrafted', { proposal: structuredClone(proposal) });
  }
}