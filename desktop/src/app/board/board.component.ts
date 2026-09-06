import { CdkDropListGroup } from '@angular/cdk/drag-drop';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { BoardFilter, Card, CardType, Lane, Stage } from '../core/models/board.models';
import { CardCreatorComponent } from './card-creator.component';
import { BoardColumnComponent } from './board-column.component';
import { BoardSwimlaneComponent } from './board-swimlane.component';
import { BoardService } from './board.service';
import { CardPanelComponent } from './card-panel.component';
import { TypeSelectorComponent } from './type-selector.component';

/**
 * Board view: type selector across the top; the All swimlane or one
 * per-type board below; a card detail panel opens beside the board on wide
 * windows (narrow windows take it full-area). The rejection comment bar
 * docks at the bottom after an approval → implement-lane drag.
 */
@Component({
  selector: 'app-board',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CdkDropListGroup,
    TypeSelectorComponent,
    CardCreatorComponent,
    BoardColumnComponent,
    BoardSwimlaneComponent,
    CardPanelComponent,
  ],
  templateUrl: './board.component.html',
  styleUrl: './board.component.scss',
})
export class BoardComponent {
  private readonly board = inject(BoardService);

  protected readonly filter = signal<BoardFilter>('all');
  protected readonly creating = signal(false);
  protected readonly cards = this.board.cards;
  protected readonly blockedIds = this.board.blockedIds;
  protected readonly selectedCard = this.board.selectedCard;
  protected readonly rejectionPrompt = this.board.rejectionPrompt;

  /** Lanes of the active per-type board (empty in the All view). */
  protected readonly lanes = computed<readonly Stage[]>(() => {
    const f = this.filter();
    return f === 'all' ? [] : Lane.forType(f);
  });

  protected cardsFor(lane: Stage): readonly Card[] {
    const f = this.filter();
    return f === 'all' ? [] : Card.inLane(this.cards(), f as CardType, lane);
  }

  protected recordRejection(comment: string): void {
    this.board.recordRejectionComment(comment);
  }

  protected skipRejection(): void {
    this.board.dismissRejectionPrompt();
  }
}
