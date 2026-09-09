import { Injectable, computed, inject, signal } from '@angular/core';

import { EventsClient } from '../core/events/events-client';
import {
  DomainEventJson,
  WireRejectionCode,
  assigneeFromWire,
  cardFromWire,
  cardTypeFromWire,
  cardTypeToWire,
  domainEventKind,
  stepStateStatusFromWire,
} from '../core/events/wire';
import {
  Assignee,
  AutomationState,
  Card,
  CardData,
  CardType,
} from '../core/models/board.models';
import { PipelineService } from '../pipelines/pipeline.service';
import { ShellService } from '../shell/shell.service';

export type MoveRejection =
  | 'unknown-card'
  | 'unknown-step'
  | 'run-active'
  | 'blocked'
  | 'unavailable';

export type MoveResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: MoveRejection };

/** Set after a drag out of the terminal stage, awaiting an optional comment. */
export interface RejectionPrompt {
  readonly cardId: string;
}

/** A rejection drag whose publish is deferred until the comment prompt resolves. */
interface PendingRejection {
  readonly projectId: string;
  readonly cardId: string;
  readonly toStepId: string;
  readonly before: Card;
}

/**
 * Board state: a fold of the event stream (CardCreated, CardStepMoved, …)
 * with optimistic commands. Phase 10: cards carry their assigned pipeline
 * and current stage; moves are stage moves and lock while a run is active;
 * the board's columns come from the assigned pipeline's visible stages
 * (the columns component owns that projection).
 *
 * The UI issues commands (requestMove, changeType, toggleAutomation, …); each
 * applies locally, publishes, and reverts on a typed rejection. The canonical
 * events then arrive on the stream and reconcile the same signals — folds are
 * idempotent. State is kept per project; the exposed signals track the
 * shell's active tab.
 */
@Injectable({ providedIn: 'root' })
export class BoardService {
  private static readonly SEEN_IDS_CAP = 4096;

  private readonly events = inject(EventsClient);
  private readonly shell = inject(ShellService);
  private readonly pipelines = inject(PipelineService);

  private readonly cardsByProject = signal<ReadonlyMap<string, readonly Card[]>>(new Map());
  private readonly automationByProject = signal<ReadonlyMap<string, AutomationState>>(
    new Map(),
  );

  private readonly projectId = computed(() => this.shell.activeTabId());

  readonly cards = computed(() => this.cardsByProject().get(this.projectId() ?? '') ?? []);

  readonly cardsById = computed(() => new Map(this.cards().map((c) => [c.id, c])));

  /** Whether a card has reached its pipeline's terminal stage. */
  private readonly isDoneOf = (card: Card): boolean => {
    const pipeline = this.pipelines.pipelineById(card.pipelineId);
    return pipeline !== undefined && pipeline.terminalStepId === card.stepId;
  };

  readonly blockedIds = computed(() => {
    const byId = this.cardsById();
    return new Set(
      this.cards()
        .filter((c) => c.isBlockedIn(byId, this.isDoneOf))
        .map((c) => c.id),
    );
  });

  /** Automation toggles per pipeline stage of the active project. */
  readonly automation = computed(
    () => this.automationByProject().get(this.projectId() ?? '') ?? AutomationState.initial(),
  );

  /** Card shown in the full-screen detail panel; null while browsing the board. */
  private readonly selectedId = signal<string | null>(null);
  readonly selectedCard = computed(() => {
    const id = this.selectedId();
    return id === null ? null : (this.cardsById().get(id) ?? null);
  });

  /** Awaiting an optional comment after a terminal-stage-exit drag (design.md §3.4). */
  readonly rejectionPrompt = signal<RejectionPrompt | null>(null);
  private pendingRejection: PendingRejection | null = null;

  /** Set while a create is in flight; the next cardCreated echo opens the panel. */
  private openAfterCreate = false;

  private readonly seenEventIds = new Map<string, true>();

  constructor() {
    this.events.events$.subscribe((event) => this.fold(event));
  }

  // ---- Commands (optimistic; publish and revert on rejection) ----

  /**
   * RequestCardCreate: the only way to author a card outside the planner.
   * The server assigns the id and places it in the selected pipeline;
   * the card lands via its `cardCreated` echo (and opens in the detail panel).
   */
  async createCard(draft: {
    title: string;
    description: string;
    type: CardType;
    pipelineId: string;
  }): Promise<{ ok: boolean; reason?: string }> {
    const projectId = this.projectId();
    if (!projectId) return { ok: false, reason: 'unavailable' };
    const title = draft.title.trim();
    if (title === '') return { ok: false, reason: 'a card needs a title' };

    this.openAfterCreate = true;
    const response = await this.events.publish({
      projectId,
      requestCardCreate: {
        title,
        ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
        type: cardTypeToWire(draft.type),
        pipelineId: draft.pipelineId,
      },
    });
    if (!response.ok) {
      this.openAfterCreate = false;
      return {
        ok: false,
        reason: response.rejectionMessage ?? rejectionReason(response.rejectionCode),
      };
    }
    return { ok: true };
  }

  /**
   * RequestCardStepMove. Dragging out of the pipeline's terminal step is a
   * rejection-style move and opens the comment prompt before publishing, so
   * the comment rides on the move (design.md §3.4). A run on the card locks
   * it (the server rejects; the optimistic patch reverts).
   */
  async requestMove(cardId: string, toStepId: string): Promise<MoveResult> {
    const card = this.cardsById().get(cardId);
    if (!card) return { ok: false, reason: 'unknown-card' };
    const pipeline = this.pipelines.pipelineById(card.pipelineId);
    if (pipeline === undefined || pipeline.stepById(toStepId) === undefined) {
      return { ok: false, reason: 'unknown-step' };
    }
    if (this.pipelines.runForCard(cardId) !== undefined) {
      return { ok: false, reason: 'run-active' };
    }
    if (card.isBlockedIn(this.cardsById(), this.isDoneOf)) return { ok: false, reason: 'blocked' };
    if (card.stepId === toStepId) return { ok: true };

    if (card.isRejectionMove(toStepId, pipeline.terminalStepId)) {
      this.flushPendingRejection();
      const projectId = this.projectId();
      if (!projectId) return { ok: false, reason: 'unavailable' };
      this.pendingRejection = { projectId, cardId, toStepId, before: card };
      this.patch(cardId, { stepId: toStepId, updatedAt: now() });
      this.rejectionPrompt.set({ cardId });
      return { ok: true };
    }
    return this.move(cardId, toStepId, card, {});
  }

  /** RequestCardStepMove with override: step validity enforced, blockers bypassed. */
  async forceMove(cardId: string, toStepId: string): Promise<MoveResult> {
    const card = this.cardsById().get(cardId);
    if (!card) return { ok: false, reason: 'unknown-card' };
    const pipeline = this.pipelines.pipelineById(card.pipelineId);
    if (pipeline === undefined || pipeline.stepById(toStepId) === undefined) {
      return { ok: false, reason: 'unknown-step' };
    }
    if (this.pipelines.runForCard(cardId) !== undefined) {
      return { ok: false, reason: 'run-active' };
    }
    if (card.stepId === toStepId) return { ok: true };
    return this.move(cardId, toStepId, card, { override: true });
  }

  /** RequestCardPipelineAssign — the card moves to the pipeline's first stage. */
  async assignPipeline(cardId: string, pipelineId: string): Promise<MoveResult> {
    const projectId = this.projectId();
    const card = this.cardsById().get(cardId);
    if (!card || !projectId) return { ok: false, reason: 'unavailable' };
    const pipeline = this.pipelines.pipelineById(pipelineId);
    if (pipeline === undefined) return { ok: false, reason: 'unknown-step' };
    const before = card;

    this.patch(cardId, { pipelineId, stepId: pipeline.steps[0]?.id ?? '', updatedAt: now() });
    const response = await this.events.publish({
      projectId,
      requestCardPipelineAssign: { cardId, pipelineId },
    });
    if (response.ok) return { ok: true };
    this.restoreIn(projectId, before);
    return { ok: false, reason: rejectionReason(response.rejectionCode) };
  }

  /** RequestCardReopen — a completed card returns to its pipeline's first stage. */
  async reopen(cardId: string): Promise<MoveResult> {
    const projectId = this.projectId();
    const card = this.cardsById().get(cardId);
    if (!card || !projectId) return { ok: false, reason: 'unavailable' };
    const pipeline = this.pipelines.pipelineById(card.pipelineId);
    const firstStep = pipeline?.steps[0]?.id;
    if (pipeline === undefined || firstStep === undefined) {
      return { ok: false, reason: 'unknown-step' };
    }
    const before = card;

    this.patch(cardId, { stepId: firstStep, updatedAt: now() });
    const response = await this.events.publish({
      projectId,
      requestCardReopen: { cardId },
    });
    if (response.ok) return { ok: true };
    this.restoreIn(projectId, before);
    return { ok: false, reason: rejectionReason(response.rejectionCode) };
  }

  /** Flip a pipeline stage's automation toggle (RequestAutomationToggle). */
  async toggleAutomation(pipelineId: string, stepId: string): Promise<void> {
    const projectId = this.projectId();
    if (!projectId) return;
    const before = this.automation();
    this.setAutomation(projectId, before.toggle(pipelineId, stepId));
    const response = await this.events.publish({
      projectId,
      requestAutomationToggle: { pipelineId, stepId, on: !before.isOn(pipelineId, stepId) },
    });
    if (!response.ok) this.setAutomation(projectId, before);
  }

  /**
   * RequestCardTypeChange: the server resets the step states; the stage
   * stays where it is (stages are pipeline-local, not type-bound).
   */
  async changeType(cardId: string, type: CardType): Promise<MoveResult> {
    const card = this.cardsById().get(cardId);
    if (!card) return { ok: false, reason: 'unknown-card' };
    if (card.type === type) return { ok: true };
    const projectId = this.projectId();
    if (!projectId) return { ok: false, reason: 'unavailable' };

    this.patch(cardId, { type, stepStates: {}, updatedAt: now() });
    const response = await this.events.publish({
      projectId,
      requestCardTypeChange: { cardId, toType: cardTypeToWire(type) },
    });
    if (response.ok) return { ok: true };
    this.restoreIn(projectId, card);
    return { ok: false, reason: rejectionReason(response.rejectionCode) };
  }

  /** RequestCardArchive: drops the card from the board. */
  async archive(cardId: string): Promise<void> {
    const card = this.cardsById().get(cardId);
    const projectId = this.projectId();
    if (!card || !projectId) return;

    this.removeIn(projectId, cardId);
    if (this.selectedId() === cardId) this.closeCard();
    const response = await this.events.publish({
      projectId,
      requestCardArchive: { cardId },
    });
    if (!response.ok) this.restoreIn(projectId, card);
  }

  // ---- Local-only UI state ----

  openCard(cardId: string): void {
    if (this.cardsById().has(cardId)) this.selectedId.set(cardId);
  }

  closeCard(): void {
    this.selectedId.set(null);
  }

  /** RequestCardAssign — persists with the card; survives reloads. */
  async assignToMe(cardId: string): Promise<void> {
    await this.assign(cardId, Assignee.human());
  }

  async unassign(cardId: string): Promise<void> {
    await this.assign(cardId, undefined);
  }

  private async assign(cardId: string, assignee: Assignee | undefined): Promise<void> {
    const card = this.cardsById().get(cardId);
    const projectId = this.projectId();
    if (!card || !projectId) return;
    const before = card;

    this.patch(cardId, { assignee, updatedAt: now() });
    const response = await this.events.publish({
      projectId,
      requestCardAssign: {
        cardId,
        ...(assignee
          ? {
              assignee: {
                role: assignee.role,
                ...(assignee.model ? { model: assignee.model } : {}),
                ...(assignee.effort ? { effort: assignee.effort } : {}),
              },
            }
          : {}),
      },
    });
    if (!response.ok) this.restoreIn(projectId, before);
  }

  /** Record the rejection prompt's comment and publish the deferred move. */
  recordRejectionComment(comment: string): void {
    const pending = this.pendingRejection;
    this.clearRejectionPrompt();
    if (!pending) return;
    const trimmed = comment.trim();
    if (trimmed) this.patch(pending.cardId, { rejectionComment: trimmed, updatedAt: now() });
    void this.publishRejection(pending, trimmed);
  }

  dismissRejectionPrompt(): void {
    const pending = this.pendingRejection;
    this.clearRejectionPrompt();
    if (pending) void this.publishRejection(pending, '');
  }

  // ---- Event fold (stream → signals; idempotent) ----

  private fold(event: DomainEventJson): void {
    if (event.id) {
      if (this.seenEventIds.has(event.id)) return;
      this.seenEventIds.set(event.id, true);
      if (this.seenEventIds.size > BoardService.SEEN_IDS_CAP) {
        const oldest = this.seenEventIds.keys().next().value;
        if (oldest !== undefined) this.seenEventIds.delete(oldest);
      }
    }
    const projectId = event.projectId ?? '';
    switch (domainEventKind(event)) {
      case 'cardCreated': {
        const json = event.cardCreated?.card;
        if (json) {
          this.upsertIn(json.projectId || projectId, cardFromWire(json));
          if (this.openAfterCreate) {
            this.openAfterCreate = false;
            this.selectedId.set(json.id ?? null);
          }
        }
        break;
      }
      case 'cardsCommitted': {
        for (const json of event.cardsCommitted?.cards ?? []) {
          this.upsertIn(json.projectId || projectId, cardFromWire(json));
        }
        break;
      }
      case 'cardStepMoved': {
        const payload = event.cardStepMoved;
        if (!payload?.cardId) break;
        this.patchIn(projectId, payload.cardId, (card) => ({
          stepId: payload.toStepId,
          rejectionComment: payload.comment ? payload.comment : card.rejectionComment,
          updatedAt: event.occurredAt ?? card.updatedAt,
        }));
        break;
      }
      case 'cardPipelineAssigned': {
        const payload = event.cardPipelineAssigned;
        if (!payload?.cardId) break;
        this.patchIn(projectId, payload.cardId, (card) => ({
          pipelineId: payload.pipelineId,
          stepId: payload.stepId,
          updatedAt: event.occurredAt ?? card.updatedAt,
        }));
        break;
      }
      case 'cardTypeChanged': {
        const payload = event.cardTypeChanged;
        if (!payload?.cardId) break;
        const type = cardTypeFromWire(payload.to);
        this.patchIn(projectId, payload.cardId, (card) => ({
          type,
          stepStates: {},
          updatedAt: event.occurredAt ?? card.updatedAt,
        }));
        break;
      }
      case 'cardAssigned': {
        const payload = event.cardAssigned;
        if (!payload?.cardId) break;
        this.patchIn(projectId, payload.cardId, (card) => ({
          assignee: assigneeFromWire(payload.assignee),
          updatedAt: event.occurredAt ?? card.updatedAt,
        }));
        break;
      }
      case 'cardArchived': {
        const cardId = event.cardArchived?.cardId;
        if (!cardId) break;
        this.removeIn(projectId, cardId);
        if (this.selectedId() === cardId) this.closeCard();
        break;
      }
      case 'cardStepStateUpdated': {
        const payload = event.cardStepStateUpdated;
        if (!payload?.cardId || !payload.stepId) break;
        this.patchIn(projectId, payload.cardId, (card) => ({
          stepStates: {
            ...card.stepStates,
            [payload.stepId!]: stepStateStatusFromWire(payload.status),
          },
          updatedAt: event.occurredAt ?? card.updatedAt,
        }));
        break;
      }
      case 'pipelineStepStarted': {
        const payload = event.pipelineStepStarted;
        if (!payload?.cardId || !payload.stepId) break;
        this.patchIn(projectId, payload.cardId, (card) => ({
          stepId: payload.stepId,
          stepStates: { ...card.stepStates, [payload.stepId]: 'running' },
          updatedAt: event.occurredAt ?? card.updatedAt,
        }));
        break;
      }
      case 'pipelineStepFinished': {
        const payload = event.pipelineStepFinished;
        if (!payload?.cardId || !payload.stepId) break;
        this.patchIn(projectId, payload.cardId, (card) => ({
          stepStates: { ...card.stepStates, [payload.stepId]: payload.ok ? 'ok' : 'failed' },
          updatedAt: event.occurredAt ?? card.updatedAt,
        }));
        break;
      }
      case 'automationToggled': {
        const payload = event.automationToggled;
        if (!payload?.pipelineId || !payload.stepId) break;
        const current = this.automationByProject().get(projectId) ?? AutomationState.initial();
        this.setAutomation(
          projectId,
          current.set(payload.pipelineId, payload.stepId, payload.on ?? false),
        );
        break;
      }
      // dependencyStateChanged: blocked-ness derives locally via blockedIds.
    }
  }

  // ---- Internals ----

  private async move(
    cardId: string,
    toStepId: string,
    before: Card,
    options: { readonly override?: boolean },
  ): Promise<MoveResult> {
    const projectId = this.projectId();
    if (!projectId) return { ok: false, reason: 'unavailable' };

    this.patch(cardId, { stepId: toStepId, updatedAt: now() });
    const response = await this.events.publish({
      projectId,
      requestCardStepMove: {
        cardId,
        toStepId,
        override: options.override ?? false,
        comment: '',
      },
    });
    if (response.ok) return { ok: true };
    this.restoreIn(projectId, before);
    return { ok: false, reason: rejectionReason(response.rejectionCode) };
  }

  private async publishRejection(pending: PendingRejection, comment: string): Promise<void> {
    const response = await this.events.publish({
      projectId: pending.projectId,
      requestCardStepMove: {
        cardId: pending.cardId,
        toStepId: pending.toStepId,
        override: false,
        comment,
      },
    });
    if (!response.ok) this.restoreIn(pending.projectId, pending.before);
  }

  /** Publish a previously deferred rejection move before another can start. */
  private flushPendingRejection(): void {
    const pending = this.pendingRejection;
    this.clearRejectionPrompt();
    if (pending) void this.publishRejection(pending, '');
  }

  private clearRejectionPrompt(): void {
    this.pendingRejection = null;
    this.rejectionPrompt.set(null);
  }

  private patch(id: string, changes: Partial<CardData>): void {
    const projectId = this.projectId();
    if (projectId) this.patchIn(projectId, id, () => changes);
  }

  private patchIn(
    projectId: string,
    id: string,
    changes: (card: Card) => Partial<CardData>,
  ): void {
    this.cardsByProject.update((map) => {
      const cards = map.get(projectId);
      if (!cards?.some((c) => c.id === id)) return map;
      const next = new Map(map);
      next.set(projectId, cards.map((c) => (c.id === id ? c.with(changes(c)) : c)));
      return next;
    });
  }

  private upsertIn(projectId: string, card: Card): void {
    if (!projectId) return;
    this.cardsByProject.update((map) => {
      const cards = map.get(projectId) ?? [];
      const next = new Map(map);
      next.set(
        projectId,
        cards.some((c) => c.id === card.id)
          ? cards.map((c) => (c.id === card.id ? card : c))
          : [...cards, card],
      );
      return next;
    });
  }

  private restoreIn(projectId: string, before: Card): void {
    this.cardsByProject.update((map) => {
      const cards = map.get(projectId) ?? [];
      const next = new Map(map);
      next.set(
        projectId,
        cards.some((c) => c.id === before.id)
          ? cards.map((c) => (c.id === before.id ? before : c))
          : [...cards, before],
      );
      return next;
    });
  }

  private removeIn(projectId: string, id: string): void {
    this.cardsByProject.update((map) => {
      const cards = map.get(projectId);
      if (!cards?.some((c) => c.id === id)) return map;
      const next = new Map(map);
      next.set(
        projectId,
        cards.filter((c) => c.id !== id),
      );
      return next;
    });
  }

  private setAutomation(projectId: string, state: AutomationState): void {
    this.automationByProject.update((map) => {
      const next = new Map(map);
      next.set(projectId, state);
      return next;
    });
  }
}

function rejectionReason(code: string | undefined): MoveRejection {
  switch (code) {
    case WireRejectionCode.REJECTION_CODE_UNKNOWN_CARD:
      return 'unknown-card';
    case WireRejectionCode.REJECTION_CODE_UNKNOWN_STEP:
      return 'unknown-step';
    case WireRejectionCode.REJECTION_CODE_RUN_ACTIVE:
      return 'run-active';
    case WireRejectionCode.REJECTION_CODE_BLOCKED:
      return 'blocked';
    default:
      return 'unavailable';
  }
}

function now(): string {
  return new Date().toISOString();
}
