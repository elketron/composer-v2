import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { ArrowLeft, MessageSquare } from 'lucide-angular';

import { AgePipe } from '../core/age.pipe';
import {
  CARD_TYPE_META,
  CARD_TYPES,
  Card,
  CardType,
  Lane,
  Stage,
} from '../core/models/board.models';
import { BoardService } from './board.service';

/**
 * Card detail panel (design.md §3.3): full-screen, replaces the board view.
 * Editable type selector (changing type resets the pipeline checklist), full
 * description, dependency graph in both directions, per-type pipeline
 * checklist, session metadata, and the action footer.
 */
@Component({
  selector: 'app-card-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, AgePipe],
  templateUrl: './card-panel.component.html',
  styleUrl: './card-panel.component.scss',
  host: { '(document:keydown.escape)': 'close()' },
})
export class CardPanelComponent {
  private readonly board = inject(BoardService);

  readonly card = input.required<Card>();

  protected readonly meta = computed(() => this.card().meta);
  protected readonly checklist = computed(() => this.card().checklist());
  protected readonly blockers = computed(() => this.card().blockers(this.board.cardsById()));
  protected readonly blocking = computed(() => this.card().blocking(this.board.cards()));
  protected readonly moveTargets = computed(() =>
    this.card().lanes.filter((lane) => lane !== this.card().stage),
  );

  protected readonly typeOptions = CARD_TYPES;
  protected readonly typeMeta = CARD_TYPE_META;
  protected readonly icons = { back: ArrowLeft, session: MessageSquare };

  protected laneLabel(lane: Stage): string {
    return Lane.label(lane);
  }

  protected close(): void {
    this.board.closeCard();
  }

  protected changeType(type: CardType): void {
    void this.board.changeType(this.card().id, type);
  }

  protected openRelated(cardId: string): void {
    this.board.openCard(cardId);
  }

  protected assignToMe(): void {
    this.board.assignToMe(this.card().id);
  }

  protected unassign(): void {
    this.board.unassign(this.card().id);
  }

  protected forceMove(lane: string): void {
    if (lane) void this.board.forceMove(this.card().id, lane as Stage);
  }

  protected archive(): void {
    void this.board.archive(this.card().id);
  }
}
