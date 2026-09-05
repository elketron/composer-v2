import { CdkDrag, CdkDragDrop, CdkDropList, CdkDropListGroup } from '@angular/cdk/drag-drop';
import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';

import { Card, CardType, Lane, Stage, SwimlaneRow } from '../core/models/board.models';
import { BoardCardComponent } from './board-card.component';
import { BoardService } from './board.service';

/**
 * All view (design.md §3.1): swimlane composite. Rows are card types, columns
 * are the union of all lanes; lanes a type doesn't use are dimmed in that row.
 * Each row is its own drop group, so a card can never be dragged into another
 * type's row (type changes happen in the panel, not by drag). Agent-owned
 * lane headers carry the same automation toggle as the per-type boards.
 */
@Component({
  selector: 'app-board-swimlane',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CdkDropListGroup, CdkDropList, CdkDrag, BoardCardComponent, LucideAngularModule],
  templateUrl: './board-swimlane.component.html',
  styleUrl: './board-swimlane.component.scss',
})
export class BoardSwimlaneComponent {
  private readonly board = inject(BoardService);

  readonly cards = input.required<readonly Card[]>();
  readonly blockedIds = input.required<ReadonlySet<string>>();

  protected readonly rows = SwimlaneRow.all();
  protected readonly lanes = Lane.ALL;

  protected laneLabel(lane: Stage): string {
    return Lane.label(lane);
  }

  protected agentOwned(lane: Stage): boolean {
    return Lane.isAgentOwned(lane);
  }

  protected automationOn(lane: Stage): boolean {
    return this.board.automation().isOn(lane);
  }

  protected toggleAutomation(lane: Stage): void {
    void this.board.toggleAutomation(lane);
  }

  protected cardsFor(type: CardType, lane: Stage): readonly Card[] {
    return Card.inLane(this.cards(), type, lane);
  }

  protected countFor(type: CardType): number {
    return this.cards().filter((c) => c.type === type).length;
  }

  protected open(card: Card): void {
    this.board.openCard(card.id);
  }

  protected onDrop(event: CdkDragDrop<Stage>): void {
    if (event.previousContainer === event.container) return;
    const card = event.item.data as Card;
    this.board.requestMove(card.id, event.container.data);
  }
}
