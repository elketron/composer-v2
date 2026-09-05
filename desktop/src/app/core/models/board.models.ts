import { Code, FileText, LucideIconData, PenTool } from 'lucide-angular';

// Board domain models (docs/frontend/design.md §6.1) — readonly, behavior-rich
// classes. All board logic lives here as model methods; components render
// models and forward events, services only hold state and issue commands.
// Models never do I/O.

export type CardType = 'coding' | 'design' | 'docs';

export type Stage =
  | 'new'
  | 'coding'
  | 'design'
  | 'docs'
  | 'validation'
  | 'review'
  | 'security'
  | 'approval'
  | 'done';

export type AgentRole =
  | 'coder'
  | 'designer'
  | 'docs-writer'
  | 'tester'
  | 'reviewer'
  | 'security'
  | 'human';

export type SubStateStage =
  | 'retrieveContext'
  | 'implement'
  | 'writeTests'
  | 'runValidation'
  | 'reviewChanges'
  | 'securityReview'
  | 'humanReview'
  | 'draft'
  | 'peerReview';

export type SubStateStatus = 'pending' | 'running' | 'ok' | 'failed';

export type SubState = Readonly<Partial<Record<SubStateStage, SubStateStatus>>>;

/** Board type filter: the All swimlane or one per-type board. */
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

/** Lane semantics of the board's state machine (design.md §3.1). */
export class Lane {
  /** Union of all lanes in display order — the columns of the All swimlane. */
  static readonly ALL: readonly Stage[] = [
    'new',
    'coding',
    'design',
    'docs',
    'validation',
    'review',
    'security',
    'approval',
    'done',
  ];

  /** Lanes owned by an agent (automation toggles sit on these headers). */
  static readonly AGENT_OWNED: ReadonlySet<Stage> = new Set<Stage>([
    'coding',
    'design',
    'docs',
    'validation',
    'review',
    'security',
  ]);

  /** Lanes per type, left to right. Security is code-only. */
  private static readonly BY_TYPE: Record<CardType, readonly Stage[]> = {
    coding: ['new', 'coding', 'validation', 'review', 'security', 'approval', 'done'],
    design: ['new', 'design', 'validation', 'review', 'approval', 'done'],
    docs: ['new', 'docs', 'validation', 'review', 'approval', 'done'],
  };

  private static readonly LABELS: Record<Stage, string> = {
    new: 'new',
    coding: 'coding',
    design: 'design',
    docs: 'docs',
    validation: 'validation',
    review: 'review',
    security: 'security',
    approval: 'approval',
    done: 'done',
  };

  private constructor() {}

  static label(stage: Stage): string {
    return Lane.LABELS[stage];
  }

  static forType(type: CardType): readonly Stage[] {
    return Lane.BY_TYPE[type];
  }

  static isValidFor(type: CardType, stage: Stage): boolean {
    return Lane.BY_TYPE[type].includes(stage);
  }

  static isAgentOwned(stage: Stage): boolean {
    return Lane.AGENT_OWNED.has(stage);
  }

  /**
   * The lane a card returns to when its work is rejected (design.md §3.4).
   * Implement lanes are named after their type, so this is the type itself.
   */
  static implementFor(type: CardType): Stage {
    return type;
  }
}

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
  /** Drives lanes, sub-state and accent. Changed in the panel, never by drag. */
  readonly type: CardType;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  /** Must always be in Lane.forType(type). */
  readonly stage: Stage;
  readonly blockedBy: readonly string[];
  readonly assignee?: Assignee;
  readonly sessionId?: string;
  readonly branch?: string;
  readonly fileStats?: FileStats;
  readonly subState: SubState;
  readonly retries: Readonly<Record<string, number>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Latest comment recorded by an approval → implement-lane rejection drag. */
  readonly rejectionComment?: string;
}

/** One row of the per-type pipeline checklist in the card panel. */
export interface ChecklistEntry {
  readonly stage: SubStateStage;
  readonly label: string;
  readonly status: SubStateStatus;
  readonly retries: number;
}

export class Card {
  /** Per-type pipeline checklist stages (design.md §3.3). */
  private static readonly SUBSTATE: Record<CardType, readonly SubStateStage[]> = {
    coding: [
      'retrieveContext',
      'implement',
      'writeTests',
      'runValidation',
      'reviewChanges',
      'securityReview',
      'humanReview',
    ],
    design: ['draft', 'implement', 'runValidation', 'reviewChanges', 'humanReview'],
    docs: ['draft', 'implement', 'runValidation', 'reviewChanges', 'humanReview'],
  };

  private static readonly SUBSTATE_LABELS: Record<SubStateStage, string> = {
    retrieveContext: 'retrieve context',
    implement: 'implement',
    writeTests: 'write tests',
    runValidation: 'run validation',
    reviewChanges: 'review changes',
    securityReview: 'security review',
    humanReview: 'human review',
    draft: 'draft',
    peerReview: 'peer review',
  };

  readonly id: string;
  readonly type: CardType;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly stage: Stage;
  readonly blockedBy: readonly string[];
  readonly assignee?: Assignee;
  readonly sessionId?: string;
  readonly branch?: string;
  readonly fileStats?: FileStats;
  readonly subState: SubState;
  readonly retries: Readonly<Record<string, number>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly rejectionComment?: string;

  constructor(data: CardData) {
    this.id = data.id;
    this.type = data.type;
    this.title = data.title;
    this.description = data.description;
    this.tags = data.tags;
    this.stage = data.stage;
    this.blockedBy = data.blockedBy;
    this.assignee = data.assignee;
    this.sessionId = data.sessionId;
    this.branch = data.branch;
    this.fileStats = data.fileStats;
    this.subState = data.subState;
    this.retries = data.retries;
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;
    this.rejectionComment = data.rejectionComment;
  }

  get meta(): CardTypeMeta {
    return CARD_TYPE_META[this.type];
  }

  /** Lanes this card may occupy, in board order. */
  get lanes(): readonly Stage[] {
    return Lane.forType(this.type);
  }

  isLaneValid(lane: Stage): boolean {
    return Lane.isValidFor(this.type, lane);
  }

  /** The lane this card returns to when its work is rejected. */
  implementLane(): Stage {
    return Lane.implementFor(this.type);
  }

  /** An agent is actively working the card (assigned and in an agent-owned lane). */
  isWorking(): boolean {
    return this.assignee !== undefined && Lane.isAgentOwned(this.stage);
  }

  /**
   * A drag from Approval back to the type's implement lane is a rejection
   * (design.md §3.4) — it may carry an optional comment.
   */
  isRejectionMove(toLane: Stage): boolean {
    return this.stage === 'approval' && toLane === this.implementLane();
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

  /** Blocked while any blocker is not done. */
  isBlockedIn(cardsById: ReadonlyMap<string, Card>): boolean {
    return this.blockers(cardsById).some((blocker) => blocker.stage !== 'done');
  }

  /** The type's pipeline stages, in order. */
  checklistStages(): readonly SubStateStage[] {
    return Card.SUBSTATE[this.type];
  }

  /** Per-type pipeline checklist; stages without state read as pending. */
  checklist(): ChecklistEntry[] {
    return this.checklistStages().map((stage) => ({
      stage,
      label: Card.SUBSTATE_LABELS[stage],
      status: this.subState[stage] ?? 'pending',
      retries: this.retries[stage] ?? 0,
    }));
  }

  /** Copy with changes applied (the store is immutable). */
  with(changes: Partial<CardData>): Card {
    return new Card({ ...this, ...changes });
  }

  /** Fresh sub-state checklist for a type (all stages pending). */
  static initialSubState(type: CardType): SubState {
    return Object.fromEntries(Card.SUBSTATE[type].map((s) => [s, 'pending']));
  }

  /** Cards in one lane of one type's board, in board display order. */
  static inLane(cards: readonly Card[], type: CardType, lane: Stage): readonly Card[] {
    return cards.filter((c) => c.type === type && c.stage === lane);
  }
}

/** One cell of the All swimlane: a lane column in a type's row. */
export class SwimlaneCell {
  constructor(
    /** Whether the row's type routes through this lane; invalid cells render dimmed. */
    readonly lane: Stage,
    readonly valid: boolean,
  ) {}
}

/** One row of the All swimlane: a card type and its lane cells. */
export class SwimlaneRow {
  readonly cells: readonly SwimlaneCell[];

  constructor(readonly type: CardType) {
    this.cells = Lane.ALL.map((lane) => new SwimlaneCell(lane, Lane.isValidFor(type, lane)));
  }

  get meta(): CardTypeMeta {
    return CARD_TYPE_META[this.type];
  }

  /** All-view swimlane layout: one row per type, in card-type order. */
  static all(): readonly SwimlaneRow[] {
    return CARD_TYPES.map((type) => new SwimlaneRow(type));
  }
}

/**
 * Automation toggles per agent-owned lane (design.md §3.1). Immutable; the
 * board service swaps instances on toggle. Toggles gate agent pickup only —
 * human drags are never blocked by them (MVP has no agents to gate).
 */
export class AutomationState {
  private constructor(private readonly states: ReadonlyMap<Stage, boolean>) {}

  /** All agent-owned lanes start on. */
  static initial(): AutomationState {
    return new AutomationState(new Map([...Lane.AGENT_OWNED].map((lane) => [lane, true])));
  }

  isOn(lane: Stage): boolean {
    return this.states.get(lane) ?? false;
  }

  toggle(lane: Stage): AutomationState {
    return this.set(lane, !this.isOn(lane));
  }

  set(lane: Stage, on: boolean): AutomationState {
    if (!Lane.isAgentOwned(lane)) return this;
    const next = new Map(this.states);
    next.set(lane, on);
    return new AutomationState(next);
  }

  /** Drives the status-strip agent count (mvp.md acceptance 13). */
  get onCount(): number {
    return [...this.states.values()].filter(Boolean).length;
  }
}
