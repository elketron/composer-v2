import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
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
  Lane,
  Stage,
} from '../core/models/board.models';
import { PipelineService, RunOutcome } from '../pipelines/pipeline.service';
import { ShellService } from '../shell/shell.service';
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
  private readonly router = inject(Router);
  private readonly shell = inject(ShellService);

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

  /** The last command rejection (run/stop/gate), for inline display. */
  protected readonly rejection = this.pipelines.rejection;

  /** How this card's most recent run ended (undefined = none this session). */
  protected readonly lastRun = computed(() => this.pipelines.lastRunForCard(this.card().id));

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
    const startedIso = this.run()?.stepStartedAt;
    const started = startedIso ? Date.parse(startedIso) : Number.NaN;
    if (Number.isNaN(started)) return '';
    const seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  }

  protected openRunView(): void {
    const card = this.card();
    const projectId = this.shell.activeTabId();
    if (projectId) void this.router.navigate(['/projects', projectId, 'coding', 'run', card.id]);
  }

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
    if (pipelineId === '') return;
    void this.pipelines.run(pipelineId, this.card().id).then((ok) => {
      if (ok) this.selectedPipelineId.set('');
    });
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

  protected lastRunLabel(outcome: RunOutcome): string {
    return outcome.status === 'failed'
      ? `last run failed${outcome.error ? ' — ' + outcome.error : ''}`
      : 'last run completed';
  }
}
