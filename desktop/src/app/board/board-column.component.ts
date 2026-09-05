import { CdkDrag, CdkDragDrop, CdkDropList } from '@angular/cdk/drag-drop';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { Card, Lane, Stage } from '../core/models/board.models';
import { BoardCardComponent } from './board-card.component';
import { BoardService } from './board.service';

/**
 * One lane of a per-type board. Drops issue RequestCardMove commands; accepted
 * moves re-render from the store (optimistic, same tick), rejected moves leave
 * the data untouched and the drag preview animates back on its own.
 * Agent-owned lanes carry an automation toggle in the header (design.md §3.1).
 */
@Component({
  selector: 'app-board-column',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CdkDropList, CdkDrag, BoardCardComponent],
  templateUrl: './board-column.component.html',
  styleUrl: './board-column.component.scss',
})
export class BoardColumnComponent {
  private readonly board = inject(BoardService);

  readonly lane = input.required<Stage>();
  readonly cards = input.required<readonly Card[]>();
  readonly blockedIds = input.required<ReadonlySet<string>>();

  protected readonly label = computed(() => Lane.label(this.lane()));
  protected readonly agentOwned = computed(() => Lane.isAgentOwned(this.lane()));
  protected readonly automationOn = computed(() => this.board.automation().isOn(this.lane()));

  protected toggleAutomation(): void {
    void this.board.toggleAutomation(this.lane());
  }

  protected open(card: Card): void {
    this.board.openCard(card.id);
  }

  protected onDrop(event: CdkDragDrop<Stage>): void {
    if (event.previousContainer === event.container) return;
    const card = event.item.data as Card;
    void this.board.requestMove(card.id, event.container.data);
  }
}
