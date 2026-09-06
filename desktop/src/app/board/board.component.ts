import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { BoardFilter } from '../core/models/board.models';
import { CardCreatorComponent } from './card-creator.component';
import { BoardColumnsComponent } from './board-columns.component';
import { BoardService } from './board.service';
import { CardPanelComponent } from './card-panel.component';
import { TypeSelectorComponent } from './type-selector.component';

/**
 * Board view: the type selector filters the agent-lane swimlane board —
 * rows are workers (agents, you, unassigned), columns are the stage
 * projection with the type-named implement stages collapsed. A card detail
 * panel opens beside the board on wide windows (narrow windows take it
 * full-area). The rejection comment bar docks at the bottom after an
 * approval → implement-lane drag.
 */
@Component({
  selector: 'app-board',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TypeSelectorComponent,
    CardCreatorComponent,
    BoardColumnsComponent,
    CardPanelComponent,
  ],
  templateUrl: './board.component.html',
  styleUrl: './board.component.scss',
})
export class BoardComponent {
  private readonly board = inject(BoardService);

  protected readonly filter = signal<BoardFilter>('all');
  protected readonly creating = signal(false);
  protected readonly blockedIds = this.board.blockedIds;
  protected readonly selectedCard = this.board.selectedCard;
  protected readonly rejectionPrompt = this.board.rejectionPrompt;

  /** The type selector filters the agent-lane board; 'all' shows everything. */
  protected readonly visibleCards = computed(() => {
    const f = this.filter();
    const cards = this.board.cards();
    return f === 'all' ? cards : cards.filter((card) => card.type === f);
  });

  protected recordRejection(comment: string): void {
    this.board.recordRejectionComment(comment);
  }

  protected skipRejection(): void {
    this.board.dismissRejectionPrompt();
  }
}
