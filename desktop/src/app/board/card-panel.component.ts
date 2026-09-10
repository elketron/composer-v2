import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';
import { ArrowLeft, Bot, MessageSquare, Play, Square, SquareCheck } from 'lucide-angular';

import { AgePipe } from '../core/age.pipe';
import {
  CARD_TYPE_META,
  CARD_TYPES,
  Card,
  CardType,
  StepStateStatus,
} from '../core/models/board.models';
import { Pipeline, PipelineStep, runElapsed } from '../core/models/pipeline.models';
import { PipelineService } from '../pipelines/pipeline.service';
import { ShellService } from '../shell/shell.service';
import { BoardService } from './board.service';

/**
 * Card detail panel: a side panel beside the board on wide windows (the
 * board stays visible and selectable); narrow windows take it full-area.
 * Editable type selector (changing type resets the step states), full
 * description, dependency graph in both directions, the assigned pipeline's
 * steps with their execution state, session metadata, the pipeline run
 * (progress, gate affordance, run/stop), the last run's outcome, and the
 * action footer.
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
  private readonly router = inject(Router);
  private readonly shell = inject(ShellService);

  readonly card = input.required<Card>();

  private readonly backButton = viewChild<ElementRef<HTMLButtonElement>>('backButton');

  /** The card (or other trigger) that had focus when the panel opened. */
  private readonly opener: HTMLElement | null =
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

  protected readonly meta = computed(() => this.card().meta);
  protected readonly blockers = computed(() => this.card().blockers(this.board.cardsById()));
  protected readonly blocking = computed(() => this.card().blocking(this.board.cards()));

  /** The card's assigned pipeline (its steps are the checklist). */
  protected readonly pipeline = computed<Pipeline | undefined>(
    () => this.pipelines.pipelineById(this.card().pipelineId),
  );

  /** Whether the card sits at its pipeline's terminal (Done) lane. */
  protected readonly completed = computed(() => {
    const pipeline = this.pipeline();
    return pipeline !== undefined && pipeline.isTerminalLane(this.card().laneId);
  });

  /** The pipeline's kanban-visible lanes the card may be dragged to. */
  protected readonly moveTargets = computed(() => {
    const pipeline = this.pipeline();
    if (pipeline === undefined) return [];
    return pipeline.columns().filter((lane) => lane.id !== this.card().laneId);
  });

  constructor() {
    // View effects run after the template pass: focus lands in the panel
    // (the back button) on open and when switching to a related card.
    effect(() => {
      if (this.card() === undefined) return;
      this.backButton()?.nativeElement.focus();
    });
  }

  // ---- Pipeline run (S4) ----

  protected readonly run = computed(() => this.pipelines.runForCard(this.card().id));

  /** The last command rejection (run/stop/gate), for inline display. */
  protected readonly rejection = this.pipelines.rejection;

  /** How this card's most recent run ended (undefined = none this session). */
  protected readonly lastRun = computed(() => this.pipelines.lastRunForCard(this.card().id));

  protected readonly runStep = computed(() => {
    const run = this.run();
    const pipeline = this.pipeline();
    if (run === undefined || pipeline === undefined || run.stepId === undefined) return null;
    return pipeline.stepById(run.stepId) ?? null;
  });

  protected readonly waitingAtGate = computed(() => this.run()?.status === 'waiting');

  protected readonly pipelineOptions = computed(() => this.pipelines.pipelines());

  protected readonly typeOptions = CARD_TYPES;
  protected readonly typeMeta = CARD_TYPE_META;

  protected readonly selectedPipelineId = signal('');

  protected readonly gateComment = signal('');

  // ---- The run (the full-page run view carries the live panes) ----

  protected readonly transcript = computed(() => this.pipelines.transcriptFor(this.run()?.sessionId));

  protected readonly buildOutput = computed(() => this.pipelines.commandOutputFor(this.card().id));

  protected readonly icons = {
    back: ArrowLeft,
    session: MessageSquare,
    run: Play,
    stop: Square,
    gate: SquareCheck,
    agent: Bot,
  };

  /** mm:ss since the current step started. */
  protected elapsed(): string {
    return runElapsed(this.run(), Date.now());
  }

  protected openRunView(): void {
    const card = this.card();
    const projectId = this.shell.activeTabId();
    if (projectId) void this.router.navigate(['/projects', projectId, 'coding', 'run', card.id]);
  }

  /** The steps of the assigned pipeline with the card's per-step state. */
  protected stepRows(): { step: PipelineStep; status: StepStateStatus }[] {
    const pipeline = this.pipeline();
    if (pipeline === undefined) return [];
    const states = this.card().stepStates;
    return pipeline.steps.map((step) => ({
      step,
      status: states[step.id] ?? 'pending',
    }));
  }

  protected close(): void {
    this.board.closeCard();
    // Focus returns to the card that opened the panel, not <body>.
    this.opener?.focus();
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

  protected forceMove(laneId: string): void {
    if (laneId) void this.board.forceMove(this.card().id, laneId);
  }

  protected reassign(): void {
    const pipelineId = this.selectedPipelineId();
    if (pipelineId === '') return;
    void this.board.assignPipeline(this.card().id, pipelineId).then((result) => {
      if (result.ok) this.selectedPipelineId.set('');
    });
  }

  protected reopen(): void {
    void this.board.reopen(this.card().id);
  }

  protected archive(): void {
    void this.board.archive(this.card().id);
  }

  protected startPipeline(): void {
    void this.pipelines.run(this.card().id);
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
