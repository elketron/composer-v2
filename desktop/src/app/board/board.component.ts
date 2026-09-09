import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';

import { BoardFilter } from '../core/models/board.models';
import { Pipeline } from '../core/models/pipeline.models';
import { CardCreatorComponent } from './card-creator.component';
import { BoardColumnsComponent } from './board-columns.component';
import { BoardService } from './board.service';
import { CardPanelComponent } from './card-panel.component';
import { TypeSelectorComponent } from './type-selector.component';
import { PipelineService } from '../pipelines/pipeline.service';

/**
 * Board view: one tab per pipeline (Phase 10 — each pipeline shows only its
 * Kanban-visible stages; a card appears on the tab of its assigned pipeline).
 * The type selector filters the tab's cards. A card detail panel opens beside
 * the board on wide windows (narrow windows take it full-area). The rejection
 * comment bar docks at the bottom after a drag out of the terminal stage.
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
  private readonly pipelines = inject(PipelineService);

  protected readonly filter = signal<BoardFilter>('all');
  protected readonly creating = signal(false);
  protected readonly blockedIds = this.board.blockedIds;
  protected readonly selectedCard = this.board.selectedCard;
  protected readonly rejectionPrompt = this.board.rejectionPrompt;

  /** The board tabs: one per pipeline of the project, in id order. */
  protected readonly pipelineTabs = this.pipelines.pipelines;

  /** The explicitly selected tab; null falls back to the first pipeline. */
  private readonly selectedTabId = signal<string | null>(null);
  private readonly newCardButton = viewChild<ElementRef<HTMLButtonElement>>('newCardButton');

  protected readonly selectedPipeline = computed<Pipeline | undefined>(() => {
    const id = this.selectedTabId();
    const pipelines = this.pipelineTabs();
    return pipelines.find((pipeline) => pipeline.id === id) ?? pipelines[0];
  });

  protected readonly isTabSelected = (pipeline: Pipeline): boolean =>
    this.selectedPipeline()?.id === pipeline.id;

  protected selectTab(pipelineId: string): void {
    this.creating.set(false);
    this.selectedTabId.set(pipelineId);
  }

  protected beginCreate(): void {
    if (this.selectedPipeline() !== undefined) this.creating.set(true);
  }

  protected closeCreator(): void {
    this.creating.set(false);
    queueMicrotask(() => this.newCardButton()?.nativeElement.focus());
  }

  /** The tab's cards (its assigned pipeline), filtered by the type selector. */
  protected readonly visibleCards = computed(() => {
    const f = this.filter();
    const pipelineId = this.selectedPipeline()?.id;
    const cards = this.board.cards();
    const onTab = pipelineId === undefined ? cards : cards.filter((card) => card.pipelineId === pipelineId);
    return f === 'all' ? onTab : onTab.filter((card) => card.type === f);
  });

  protected recordRejection(comment: string): void {
    this.board.recordRejectionComment(comment);
  }

  protected skipRejection(): void {
    this.board.dismissRejectionPrompt();
  }
}
