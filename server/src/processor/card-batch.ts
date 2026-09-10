// The card-batch policy (SRV-014): the planner's tickets and the assistant's
// proposal confirm both materialize a batch of drafts into cards — allocate
// ids, remap in-batch keys onto them, assign the project's default pipeline,
// build each card, then commit the batch and emit the dependency state. This
// is that shared path, parameterized by context defaults (a session id for
// tickets, none for proposal items). The two callers keep their own
// validation wording and their own terminal events (session completion vs
// proposal outcomes).

import type { Card as CardJson, CardType } from '../wire/models.js';
import { Card } from '../domain/card.js';
import type { Pipeline } from '../domain/pipeline.js';
import type { Bus } from '../bus.js';
import { allocateId } from './helpers.js';

/** One batch draft (a ticket or a proposal item), reduced to the card fields. */
export interface CardDraft {
  key?: string;
  title: string;
  cardType: CardType;
  description: string;
  blockedBy: string[];
}

/** Sequential card ids for a batch, one past the project's highest numeric suffix. */
export function allocateCardIds(known: ReadonlyMap<string, CardJson>, count: number): string[] {
  const first = Number(allocateId(known.keys(), 'T').slice(2));
  return Array.from({ length: count }, (_, offset) => `T-${first + offset}`);
}

/**
 * Builds the batch's cards: in-batch keys remap onto the freshly assigned
 * ids, and each card lands in the pipeline's first stage.
 */
export function materializeCards(
  drafts: readonly CardDraft[],
  opts: {
    projectId: string;
    ids: readonly string[];
    pipeline: Pipeline;
    now: string;
    sessionId?: string;
  },
): Card[] {
  const cardIdByKey = new Map<string, string>();
  drafts.forEach((draft, offset) => {
    if (draft.key !== undefined) cardIdByKey.set(draft.key, opts.ids[offset]!);
  });
  return drafts.map(
    (draft, offset) =>
      new Card({
        id: opts.ids[offset]!,
        projectId: opts.projectId,
        type: draft.cardType,
        title: draft.title,
        description: draft.description,
        tags: [],
        pipelineId: opts.pipeline.id,
        laneId: opts.pipeline.firstLaneId(),
        blockedBy: draft.blockedBy.map((dep) => cardIdByKey.get(dep) ?? dep),
        stepStates: {},
        ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
        createdAt: opts.now,
        updatedAt: opts.now,
      }),
  );
}

/** Commits a batch (the upsert event) then flags each blocked card. */
export async function publishCardBatch(bus: Bus, projectId: string, cards: readonly Card[]): Promise<void> {
  await bus.publish(projectId, 'cardsCommitted', { cards: [...cards] });
  for (const card of cards) {
    if (card.blockedBy.length === 0) continue;
    await bus.publish(projectId, 'dependencyStateChanged', {
      cardId: card.id,
      blocked: true,
      blockedBy: card.blockedBy,
    });
  }
}