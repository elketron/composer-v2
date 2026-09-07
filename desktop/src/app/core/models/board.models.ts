import { Code, FileText, LucideIconData, PenTool } from 'lucide-angular';

// Board domain models (docs/frontend/design.md §6.1) — readonly, behavior-rich
// classes. Phase 10: cards belong to one pipeline and sit in one of its
// stages; the fixed worker-lane Stage machine is gone (the board projects
// pipeline stages; see pipeline.models.ts). All board logic lives here as
// model methods; components render models and forward events, services only
// hold state and issue commands. Models never do I/O.

export type CardType = 'coding' | 'design' | 'docs';

export type AgentRole =
  | 'coder'
  | 'designer'
  | 'docs-writer'
  | 'tester'
  | 'reviewer'
  | 'security'
  | 'human';

export type StepStateStatus = 'pending' | 'running' | 'ok' | 'failed';

/** Board type filter: all cards or one per-type slice of the board. */
export type BoardFilter = 'all' | CardType;

export const CARD_TYPES: readonly CardType[] = ['coding', 'design', 'docs'];

export interface CardTypeMeta {
  readonly label: string;
  readonly icon: LucideIconData;
  /** CSS custom property holding the type accent (design.md §3.2). */
  readonly accentVar: string;
}

export const CARD_TYPE_META: Record<CardType, CardTypeMeta> = {
  coding: { label: 'coding', icon: Code, accentVar: 'var(--accent)' },
  design: { label: 'design', icon: PenTool, accentVar: 'var(--warn)' },
  docs: { label: 'docs', icon: FileText, accentVar: 'var(--ok)' },
};

/** Who currently works a card: an agent, or the human user. */
export class Assignee {
  private constructor(
    readonly role: AgentRole,
    readonly model: string,
    readonly effort: string,
  ) {}

  static for(role: AgentRole, model: string, effort: string): Assignee {
    return new Assignee(role, model, effort);
  }

  /** The human user picked the card up ("assign to me" in the card panel). */
  static human(): Assignee {
    return new Assignee('human', '', '');
  }

  get isHuman(): boolean {
    return this.role === 'human';
  }

  get label(): string {
    return this.isHuman ? 'you' : `${this.model} · ${this.effort}`;
  }
}

export interface FileStats {
  readonly added: number;
  readonly removed: number;
  readonly files: number;
}

/** Plain record a Card is constructed from. */
export interface CardData {
  /** Short, human-meaningful id, e.g. T-148. */
  readonly id: string;
  /** Drives the accent. Changed in the panel, never by drag. */
  readonly type: CardType;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  /** The one pipeline the card is assigned to (it appears on that pipeline's tab). */
  readonly pipelineId: string;
  /** The card's current stage of its assigned pipeline (may be a hidden stage). */
  readonly stageId: string;
  readonly blockedBy: readonly string[];
  readonly assignee?: Assignee;
  readonly sessionId?: string;
  readonly branch?: string;
  readonly fileStats?: FileStats;
  /** Per-step execution state, keyed by the assigned pipeline's step ids. */
  readonly stepStates: Readonly<Record<string, StepStateStatus>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Latest comment recorded by a drag out of the terminal stage. */
  readonly rejectionComment?: string;
}

export class Card {
  readonly id: string;
  readonly type: CardType;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly pipelineId: string;
  readonly stageId: string;
  readonly blockedBy: readonly string[];
  readonly assignee?: Assignee;
  readonly sessionId?: string;
  readonly branch?: string;
  readonly fileStats?: FileStats;
  readonly stepStates: Readonly<Record<string, StepStateStatus>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly rejectionComment?: string;

  constructor(data: CardData) {
    this.id = data.id;
    this.type = data.type;
    this.title = data.title;
    this.description = data.description;
    this.tags = data.tags;
    this.pipelineId = data.pipelineId;
    this.stageId = data.stageId;
    this.blockedBy = data.blockedBy;
    this.assignee = data.assignee;
    this.sessionId = data.sessionId;
    this.branch = data.branch;
    this.fileStats = data.fileStats;
    this.stepStates = data.stepStates;
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;
    this.rejectionComment = data.rejectionComment;
  }

  get meta(): CardTypeMeta {
    return CARD_TYPE_META[this.type];
  }

  /**
   * A drag out of the pipeline's terminal stage is a rejection-style move
   * (design.md §3.4) — it may carry an optional comment. The terminal stage
   * id comes from the card's assigned pipeline.
   */
  isRejectionMove(toStageId: string, terminalStageId: string | undefined): boolean {
    return terminalStageId !== undefined && this.stageId === terminalStageId && toStageId !== terminalStageId;
  }

  /** Blockers that exist, in blockedBy order. */
  blockers(cardsById: ReadonlyMap<string, Card>): Card[] {
    return this.blockedBy
      .map((id) => cardsById.get(id))
      .filter((c): c is Card => c !== undefined);
  }

  /** Cards that list this card as a blocker. */
  blocking(cards: readonly Card[]): Card[] {
    return cards.filter((c) => c.blockedBy.includes(this.id));
  }

  /**
   * Blocked while any blocker exists and has not reached its own pipeline's
   * terminal stage. `isDoneOf` resolves that from the pipelines' state.
   */
  isBlockedIn(cardsById: ReadonlyMap<string, Card>, isDoneOf: (card: Card) => boolean): boolean {
    return this.blockers(cardsById).some((blocker) => !isDoneOf(blocker));
  }

  /** Copy with changes applied (the store is immutable). */
  with(changes: Partial<CardData>): Card {
    return new Card({ ...this, ...changes });
  }
}

/**
 * Automation toggles per pipeline stage, keyed `<pipelineId>/<stageId>`.
 * Immutable; the board service swaps instances on toggle. Toggles are
 * persisted per stage; they gate nothing on their own (human drags are
 * never blocked by them).
 */
export class AutomationState {
  private constructor(private readonly states: ReadonlyMap<string, boolean>) {}

  static initial(): AutomationState {
    return new AutomationState(new Map());
  }

  private static key(pipelineId: string, stageId: string): string {
    return `${pipelineId}/${stageId}`;
  }

  isOn(pipelineId: string, stageId: string): boolean {
    return this.states.get(AutomationState.key(pipelineId, stageId)) ?? false;
  }

  toggle(pipelineId: string, stageId: string): AutomationState {
    return this.set(pipelineId, stageId, !this.isOn(pipelineId, stageId));
  }

  set(pipelineId: string, stageId: string, on: boolean): AutomationState {
    const next = new Map(this.states);
    next.set(AutomationState.key(pipelineId, stageId), on);
    return new AutomationState(next);
  }
}
