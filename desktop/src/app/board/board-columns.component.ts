import { CdkDrag, CdkDragDrop, CdkDropList, CdkDropListGroup } from '@angular/cdk/drag-drop';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';

import { Card } from '../core/models/board.models';
import { Pipeline, PipelineStage } from '../core/models/pipeline.models';
import { BoardCardComponent } from './board-card.component';
import { BoardService } from './board.service';

/**
 * The board: one column per Kanban-visible stage of the selected pipeline
 * (Phase 10). A card's column is the last visible stage at or before its
 * current stage — a hidden-stage task stays in its previous visible column
 * while its card shows the hidden stage and the current step. Every stage
 * column carries its automation toggle.
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

  /** A card's column: the last visible stage at or before its stage. */
  protected columnOf(card: Card): string | undefined {
    return this.pipeline().visibleStageOf(card.stageId);
  }

  protected cardsIn(column: PipelineStage): readonly Card[] {
    return this.cards().filter((card) => this.columnOf(card) === column.id);
  }

  protected automationOn(column: PipelineStage): boolean {
    return this.board.automation().isOn(this.pipeline().id, column.id);
  }

  protected toggleAutomation(column: PipelineStage): void {
    void this.board.toggleAutomation(this.pipeline().id, column.id);
  }

  protected onDrop(event: CdkDragDrop<PipelineStage>): void {
    if (event.previousContainer === event.container) return;
    const card = event.item.data as Card;
    void this.board.requestMove(card.id, event.container.data.id);
  }

  protected open(card: Card): void {
    this.board.openCard(card.id);
  }
}
