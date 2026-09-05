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
  stageFromWire,
  stageToWire,
  subStateStatusFromWire,
} from '../core/events/wire';
import {
  Assignee,
  AutomationState,
  Card,
  CardData,
  CardType,
  Lane,
  Stage,
} from '../core/models/board.models';
import { ShellService } from '../shell/shell.service';

export type MoveRejection = 'unknown-card' | 'invalid-lane' | 'blocked' | 'unavailable';

export type MoveResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: MoveRejection };

/** Set after an approval → implement-lane rejection drag, awaiting an optional comment. */
export interface RejectionPrompt {
  readonly cardId: string;
}

/** A rejection drag whose publish is deferred until the comment prompt resolves. */
interface PendingRejection {
  readonly projectId: string;
  readonly cardId: string;
  readonly toLane: Stage;
  readonly before: Card;
}

/**
 * Board state: a fold of the Events gRPC stream (CardCreated, CardMoved, …)
 * with optimistic commands over Events.Publish (docs/frontend/design.md §6.3).
 *
 * The UI issues commands (requestMove, changeType, toggleAutomation, …); each
 * applies locally, publishes, and reverts on a typed rejection. The canonical
 * events then arrive on the stream and reconcile the same signals — folds are
 * idempotent. State is kept per project; the exposed signals track the
 * shell's active tab.
 */
@Injectable({ providedIn: 'root' })
export class BoardService {
  private readonly events = inject(EventsClient);
  private readonly shell = inject(ShellService);

  private readonly cardsByProject = signal<ReadonlyMap<string, readonly Card[]>>(new Map());
  private readonly automationByProject = signal<ReadonlyMap<string, AutomationState>>(
    new Map(),
  );

  private readonly projectId = computed(() => this.shell.activeTabId());

  readonly cards = computed(() => this.cardsByProject().get(this.projectId() ?? '') ?? []);

  readonly cardsById = computed(() => new Map(this.cards().map((c) => [c.id, c])));

  readonly blockedIds = computed(() => {
    const byId = this.cardsById();
    return new Set(
      this.cards()
        .filter((c) => c.isBlockedIn(byId))
        .map((c) => c.id),
    );
  });

  /** Automation toggles per agent-owned lane of the active project. */
  readonly automation = computed(
    () => this.automationByProject().get(this.projectId() ?? '') ?? AutomationState.initial(),
  );

  /** Card shown in the full-screen detail panel; null while browsing the board. */
  private readonly selectedId = signal<string | null>(null);
  readonly selectedCard = computed(() => {
    const id = this.selectedId();
    return id === null ? null : (this.cardsById().get(id) ?? null);
  });

  /** Awaiting an optional comment after a rejection drag (design.md §3.4). */
  readonly rejectionPrompt = signal<RejectionPrompt | null>(null);
  private pendingRejection: PendingRejection | null = null;

  /** Set while a create is in flight; the next cardCreated echo opens the panel. */
  private openAfterCreate = false;

  constructor() {
    this.events.events$.subscribe((event) => this.fold(event));
  }

  // ---- Commands (optimistic; publish and revert on rejection) ----

  /**
   * RequestCardCreate: the only way to author a card outside the planner.
   * The server allocates the id; the card lands via its `cardCreated` echo
   * (and opens in the detail panel).
   */
  async createCard(draft: {
    title: string;
    description: string;
    type: CardType;
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
   * RequestCardMove. Dragging to New unassigns; dragging from Approval back
   * to the type's implement lane is a rejection and opens the comment prompt
   * before publishing, so the comment rides on the move (design.md §3.4).
   */
  async requestMove(cardId: string, toLane: Stage): Promise<MoveResult> {
    const card = this.cardsById().get(cardId);
    if (!card) return { ok: false, reason: 'unknown-card' };
    if (!card.isLaneValid(toLane)) return { ok: false, reason: 'invalid-lane' };
    if (card.isBlockedIn(this.cardsById())) return { ok: false, reason: 'blocked' };
    if (card.stage === toLane) return { ok: true };

    if (card.isRejectionMove(toLane)) {
      this.flushPendingRejection();
      const projectId = this.projectId();
      if (!projectId) return { ok: false, reason: 'unavailable' };
      this.pendingRejection = { projectId, cardId, toLane, before: card };
      this.patch(cardId, { stage: toLane, updatedAt: now() });
      this.rejectionPrompt.set({ cardId });
      return { ok: true };
    }
    return this.move(cardId, toLane, card, {});
  }

  /** RequestCardMove with override: type-validity enforced, blockers bypassed. */
  async forceMove(cardId: string, toLane: Stage): Promise<MoveResult> {
    const card = this.cardsById().get(cardId);
    if (!card) return { ok: false, reason: 'unknown-card' };
    if (!card.isLaneValid(toLane)) return { ok: false, reason: 'invalid-lane' };
    if (card.stage === toLane) return { ok: true };
    return this.move(cardId, toLane, card, { override: true });
  }

  /** Flip an agent-owned lane's automation toggle (RequestAutomationToggle). */
  async toggleAutomation(lane: Stage): Promise<void> {
    const projectId = this.projectId();
    if (!projectId || !Lane.isAgentOwned(lane)) return;
    const before = this.automation();
    this.setAutomation(projectId, before.set(lane, !before.isOn(lane)));
    const response = await this.events.publish({
      projectId,
      requestAutomationToggle: { lane: stageToWire(lane), on: !before.isOn(lane) },
    });
    if (!response.ok) this.setAutomation(projectId, before);
  }

  /**
   * RequestCardTypeChange: the server resets the sub-state checklist to the
   * new type's stages; a stage the new type doesn't route through falls back
   * to New (design.md §3.3).
   */
  async changeType(cardId: string, type: CardType): Promise<MoveResult> {
    const card = this.cardsById().get(cardId);
    if (!card) return { ok: false, reason: 'unknown-card' };
    if (card.type === type) return { ok: true };
    const projectId = this.projectId();
    if (!projectId) return { ok: false, reason: 'unavailable' };

    this.patch(cardId, {
      type,
      subState: Card.initialSubState(type),
      stage: Lane.isValidFor(type, card.stage) ? card.stage : 'new',
      updatedAt: now(),
    });
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
      case 'cardMoved': {
        const payload = event.cardMoved;
        if (!payload?.cardId) break;
        const stage = stageFromWire(payload.to);
        this.patchIn(projectId, payload.cardId, (card) => ({
          stage,
          assignee: stage === 'new' ? undefined : card.assignee,
          rejectionComment: payload.comment ? payload.comment : card.rejectionComment,
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
          subState: Card.initialSubState(type),
          stage: Lane.isValidFor(type, card.stage) ? card.stage : 'new',
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
      case 'subStateUpdated': {
        const payload = event.subStateUpdated;
        if (!payload?.cardId || !payload.stage) break;
        this.patchIn(projectId, payload.cardId, (card) => ({
          subState: { ...card.subState, [payload.stage!]: subStateStatusFromWire(payload.status) },
          updatedAt: event.occurredAt ?? card.updatedAt,
        }));
        break;
      }
      case 'automationToggled': {
        const payload = event.automationToggled;
        if (!payload?.lane) break;
        const current = this.automationByProject().get(projectId) ?? AutomationState.initial();
        // Canonical JSON omits defaults: an absent `on` means false.
        this.setAutomation(
          projectId,
          current.set(stageFromWire(payload.lane), payload.on ?? false),
        );
        break;
      }
      // dependencyStateChanged: blocked-ness derives locally via blockedIds.
    }
  }

  // ---- Internals ----

  private async move(
    cardId: string,
    toLane: Stage,
    before: Card,
    options: { readonly override?: boolean },
  ): Promise<MoveResult> {
    const projectId = this.projectId();
    if (!projectId) return { ok: false, reason: 'unavailable' };

    this.patch(cardId, {
      stage: toLane,
      assignee: toLane === 'new' ? undefined : before.assignee,
      updatedAt: now(),
    });
    const response = await this.events.publish({
      projectId,
      requestCardMove: {
        cardId,
        toLane: stageToWire(toLane),
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
      requestCardMove: {
        cardId: pending.cardId,
        toLane: stageToWire(pending.toLane),
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
    case WireRejectionCode.REJECTION_CODE_INVALID_LANE:
      return 'invalid-lane';
    case WireRejectionCode.REJECTION_CODE_BLOCKED:
      return 'blocked';
    default:
      return 'unavailable';
  }
}

function now(): string {
  return new Date().toISOString();
}
