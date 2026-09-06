import { CdkDrag, CdkDragDrop, CdkDropList, CdkDropListGroup } from '@angular/cdk/drag-drop';
import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';

import { Card, Column, DisplayColumn, Lane } from '../core/models/board.models';
import { BoardCardComponent } from './board-card.component';
import { BoardService } from './board.service';

/**
 * The board: one column per work state — backlog | coder | tester |
 * reviewer | security | approval | done — so the board reads as the path
 * work takes through the agents. The type-named implement stages collapse
 * into the coder column (a drop lands on the card's own implement stage);
 * type is a card attribute and a filter, not board structure. Agent-worked
 * columns carry automation toggles; the coder column's toggle reflects and
 * drives every type-implement stage.
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

  readonly cards = input.required<readonly Card[]>();
  readonly blockedIds = input.required<ReadonlySet<string>>();

  protected readonly columns = Column.ALL;

  protected columnLabel(column: DisplayColumn): string {
    return Column.label(column);
  }

  protected agentOwned(column: DisplayColumn): boolean {
    return Column.isAgentOwned(column);
  }

  protected cardsIn(column: DisplayColumn): readonly Card[] {
    return Column.inColumn(this.cards(), column);
  }

  /** A column's toggle: on only when every stage under it is on. */
  protected automationOn(column: DisplayColumn): boolean {
    return Column.STAGES_OF[column].every((stage) => this.board.automation().isOn(stage));
  }

  /** Drive every agent-owned stage of the column to the toggled value. */
  protected toggleAutomation(column: DisplayColumn): void {
    const target = !this.automationOn(column);
    for (const stage of Column.STAGES_OF[column]) {
      if (Lane.isAgentOwned(stage) && this.board.automation().isOn(stage) !== target) {
        void this.board.toggleAutomation(stage);
      }
    }
  }

  protected onDrop(event: CdkDragDrop<DisplayColumn>): void {
    if (event.previousContainer === event.container) return;
    const card = event.item.data as Card;
    this.board.requestMove(card.id, Column.dropStage(event.container.data, card.type));
  }

  protected open(card: Card): void {
    this.board.openCard(card.id);
  }
}
