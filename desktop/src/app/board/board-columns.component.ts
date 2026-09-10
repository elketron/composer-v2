import { CdkDrag, CdkDragDrop, CdkDropList, CdkDropListGroup } from '@angular/cdk/drag-drop';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';

import { Card } from '../core/models/board.models';
import { Pipeline, PipelineLane } from '../core/models/pipeline.models';
import { BoardCardComponent } from './board-card.component';
import { BoardService } from './board.service';

/**
 * The board: one column per kanban-visible lane of the selected pipeline
 * (Phase 10). A card's column is its assigned lane. Every lane carries its
 * automation toggle.
 */
@Component({
  selector: 'app-board-columns',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CdkDropListGroup, CdkDropList, CdkDrag, BoardCardComponent, LucideAngularModule],
  templateUrl: './board-columns.component.html',
  styleUrl: './board-columns.component.scss',
})
export class BoardColumnsComponent {
  private readonly board = inject(BoardService);

  readonly pipeline = input.required<Pipeline>();
  readonly cards = input.required<readonly Card[]>();
  readonly blockedIds = input.required<ReadonlySet<string>>();

  protected readonly columns = computed(() => this.pipeline().columns());

  protected cardsIn(column: PipelineLane): readonly Card[] {
    return this.cards().filter((card) => card.laneId === column.id);
  }

  protected automationOn(column: PipelineLane): boolean {
    return this.board.automation().isOn(this.pipeline().id, column.id);
  }

  protected toggleAutomation(column: PipelineLane): void {
    void this.board.toggleAutomation(this.pipeline().id, column.id);
  }

  protected onDrop(event: CdkDragDrop<PipelineLane>): void {
    if (event.previousContainer === event.container) return;
    const card = event.item.data as Card;
    void this.board.requestMove(card.id, event.container.data.id);
  }

  protected open(card: Card): void {
    this.board.openCard(card.id);
  }
}