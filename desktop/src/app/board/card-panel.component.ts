import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';
import { ArrowLeft, Bot, MessageSquare, Play, Square, SquareCheck } from 'lucide-angular';

import { AgePipe } from '../core/age.pipe';
import {
  CARD_TYPE_META,
  CARD_TYPES,
  Card,
  CardType,
  Lane,
  Stage,
} from '../core/models/board.models';
import { PipelineService } from '../pipelines/pipeline.service';
import { BoardService } from './board.service';

/**
 * Card detail panel (design.md §3.3): full-screen, replaces the board view.
 * Editable type selector (changing type resets the pipeline checklist), full
 * description, dependency graph in both directions, per-type pipeline
 * checklist, session metadata, the pipeline run (progress, gate affordance,
 * run/stop), and the action footer.
 */
@Component({
  selector: 'app-card-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, AgePipe, FormsModule],
  templateUrl: './card-panel.component.html',
  styleUrl: './card-panel.component.scss',
  host: { '(document:keydown.escape)': 'close()' },
})
export class CardPanelComponent {
  private readonly board = inject(BoardService);
  private readonly pipelines = inject(PipelineService);

  readonly card = input.required<Card>();

  protected readonly meta = computed(() => this.card().meta);
  protected readonly checklist = computed(() => this.card().checklist());
  protected readonly blockers = computed(() => this.card().blockers(this.board.cardsById()));
  protected readonly blocking = computed(() => this.card().blocking(this.board.cards()));
  protected readonly moveTargets = computed(() =>
    this.card().lanes.filter((lane) => lane !== this.card().stage),
  );

  // ---- Pipeline run (S4) ----

  protected readonly run = computed(() => this.pipelines.runForCard(this.card().id));

  protected readonly runPipeline = computed(() => {
    const run = this.run();
    if (run === undefined) return null;
    return this.pipelines.pipelineById(run.pipelineId) ?? null;
  });

  protected readonly runStep = computed(() => {
    const run = this.run();
    const pipeline = this.runPipeline();
    if (run === undefined || pipeline === null || run.stepId === undefined) return null;
    return pipeline.stepById(run.stepId) ?? null;
  });

  protected readonly waitingAtGate = computed(() => this.run()?.status === 'waiting');

  protected readonly pipelineOptions = computed(() => this.pipelines.pipelines());

  protected readonly typeOptions = CARD_TYPES;
  protected readonly typeMeta = CARD_TYPE_META;

  protected readonly selectedPipelineId = signal('');

  protected readonly gateComment = signal('');

  protected readonly icons = {
    back: ArrowLeft,
    session: MessageSquare,
    run: Play,
    stop: Square,
    gate: SquareCheck,
    agent: Bot,
  };

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

  protected startPipeline(): void {
    const pipelineId = this.selectedPipelineId();
    if (pipelineId !== '') void this.pipelines.run(pipelineId, this.card().id);
  }

  protected stopPipeline(): void {
    void this.pipelines.stop(this.card().id);
  }

  protected approveGate(): void {
    void this.pipelines.gateRespond(this.card().id, true, this.gateComment().trim() || undefined);
    this.gateComment.set('');
  }

  protected rejectGate(): void {
    void this.pipelines.gateRespond(this.card().id, false, this.gateComment().trim() || undefined);
    this.gateComment.set('');
  }
}
