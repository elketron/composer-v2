// The card (dual representation): the class owns the card's representation —
// `fromWire` builds it from the wire shape, `toWire()` emits it back — and
// its state is immutable: the fold replaces instances with `with()` instead
// of mutating them, so state can be shared without defensive clones. The
// blocking rule lives here as the one definition the processor's command
// validation and the snapshot's dependency replay both answer; the
// cross-object rules that need the whole board join with the aggregate.

import type {
  Assignee,
  Card as CardJson,
  CardType,
  FileStats,
  Pipeline as PipelineJson,
  SubStateStatus,
} from '../wire/models.js';

/** The board's unit of work: one card of a project, assigned to one pipeline. */
export class Card {
  readonly id: string;
  readonly projectId: string;
  readonly type: CardType;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  /** The one pipeline the card is assigned to; it appears on that pipeline's board tab. */
  readonly pipelineId: string;
  /** The card's current stage of its assigned pipeline (may be a hidden stage). */
  readonly stageId: string;
  readonly blockedBy: readonly string[];
  readonly assignee?: Assignee;
  readonly sessionId?: string;
  readonly branch?: string;
  readonly fileStats?: FileStats;
  /** Per-step execution state, keyed by the assigned pipeline's step ids. */
  readonly stepStates: Readonly<Record<string, SubStateStatus>>;
  readonly rejectionComment?: string;
  readonly createdAt: string;
  readonly updatedAt: string;

  constructor(json: CardJson) {
    this.id = json.id;
    this.projectId = json.projectId;
    this.type = json.type;
    this.title = json.title;
    this.description = json.description;
    this.tags = [...json.tags];
    this.pipelineId = json.pipelineId;
    this.stageId = json.stageId;
    this.blockedBy = [...json.blockedBy];
    if (json.assignee !== undefined) this.assignee = { ...json.assignee };
    if (json.sessionId !== undefined) this.sessionId = json.sessionId;
    if (json.branch !== undefined) this.branch = json.branch;
    if (json.fileStats !== undefined) this.fileStats = { ...json.fileStats };
    this.stepStates = { ...json.stepStates };
    if (json.rejectionComment !== undefined) this.rejectionComment = json.rejectionComment;
    this.createdAt = json.createdAt;
    this.updatedAt = json.updatedAt;
  }

  static fromWire(json: CardJson): Card {
    return new Card(json);
  }

  toWire(): CardJson {
    return {
      id: this.id,
      projectId: this.projectId,
      type: this.type,
      title: this.title,
      description: this.description,
      tags: [...this.tags],
      pipelineId: this.pipelineId,
      stageId: this.stageId,
      blockedBy: [...this.blockedBy],
      ...(this.assignee !== undefined ? { assignee: { ...this.assignee } } : {}),
      ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
      ...(this.branch !== undefined ? { branch: this.branch } : {}),
      ...(this.fileStats !== undefined ? { fileStats: { ...this.fileStats } } : {}),
      stepStates: { ...this.stepStates },
      ...(this.rejectionComment !== undefined ? { rejectionComment: this.rejectionComment } : {}),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  /**
   * Copy with changes applied. A change set to undefined drops the field —
   * the absent-optional wire rule — so unassignment and clearing ride the
   * same path as assignment.
   */
  with(changes: Partial<CardJson>): Card {
    const merged: Record<string, unknown> = { ...this.toWire() };
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete merged[key];
      else merged[key] = value;
    }
    return new Card(merged as unknown as CardJson);
  }
}

/**
 * Blocked while any blocker exists and has not reached its own pipeline's
 * terminal stage. The one definition: a missing blocker never blocks (an
 * archived dependency releases the card), and only the blocker's own
 * pipeline decides its done-ness.
 */
export function isBlockedIn(
  cardsById: ReadonlyMap<string, CardJson>,
  card: Pick<CardJson, 'blockedBy'>,
  pipelines: ReadonlyMap<string, PipelineJson>,
): boolean {
  return card.blockedBy.some((id) => {
    const blocker = cardsById.get(id);
    if (blocker === undefined) return false;
    return pipelines.get(blocker.pipelineId)?.stages.find((stage) => stage.id === blocker.stageId)?.terminal !== true;
  });
}
