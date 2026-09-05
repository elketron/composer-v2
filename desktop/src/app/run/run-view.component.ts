import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ElementRef, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, ArrowLeft, Bot, Square, Wrench } from 'lucide-angular';
import { interval } from 'rxjs';

import { AgePipe } from '../core/age.pipe';
import { RunProgress } from '../core/models/pipeline.models';
import { Card } from '../core/models/board.models';
import { RunTranscriptEntry } from '../pipelines/pipeline.service';
import { PipelineService, RunOutcome } from '../pipelines/pipeline.service';
import { BoardService } from '../board/board.service';

/**
 * The run view (design mock 2026-09-05): a full page for one card's
 * pipeline run — the agent's output streaming beside the context column
 * (usage, the card's checklist, changed files) and the command steps'
 * live output. Reachable from a board card's run chip and the card panel;
 * a finished run stays readable (durable history, outcome banner).
 */
@Component({
  selector: 'app-run-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, LucideAngularModule, AgePipe],
  templateUrl: './run-view.component.html',
  styleUrl: './run-view.component.scss',
})
export class RunViewComponent {
  private readonly board = inject(BoardService);
  private readonly pipelines = inject(PipelineService);

  /** The route param (also set directly in specs). */
  readonly cardId = input.required<string>();

  /** Ticks once a second; the elapsed clock re-reads it. */
  private readonly now = signal(Date.now());

  protected readonly card = computed<Card | undefined>(() =>
    this.board.cardsById().get(this.cardId()),
  );
  protected readonly run = computed<RunProgress | undefined>(() =>
    this.pipelines.runForCard(this.cardId()),
  );
  protected readonly outcome = computed<RunOutcome | undefined>(() =>
    this.pipelines.lastRunForCard(this.cardId()),
  );

  protected readonly runPipeline = computed(() => {
    const run = this.run();
    return run === undefined ? undefined : this.pipelines.pipelineById(run.pipelineId);
  });

  protected readonly runStep = computed(() => {
    const run = this.run();
    const pipeline = this.runPipeline();
    if (run === undefined || pipeline === undefined || run.stepId === undefined) return undefined;
    return pipeline.stepById(run.stepId);
  });

  protected readonly sessionId = computed<string | undefined>(
    () =>
      this.run()?.sessionId ??
      this.outcome()?.sessionId ??
      // After a restart the run and its outcome are gone; the newest agent
      // session for the card (durable, snapshot-replayed) is the history.
      this.pipelines
        .agentSessions()
        .find((session) => session.cardId === this.cardId())?.sessionId,
  );

  protected readonly transcript = computed<readonly RunTranscriptEntry[]>(() =>
    this.pipelines.transcriptFor(this.sessionId()),
  );

  protected readonly buildOutput = computed(() => this.pipelines.commandOutputFor(this.cardId()));

  protected readonly toolCount = computed(
    () => this.transcript().filter((entry) => entry.kind === 'tool').length,
  );
  protected readonly messageCount = computed(
    () => this.transcript().filter((entry) => entry.kind === 'message').length,
  );

  protected readonly icons = {
    back: ArrowLeft,
    agent: Bot,
    stop: Square,
    tool: Wrench,
  };

  private readonly outputPane = viewChild<ElementRef<HTMLElement>>('outputPane');
  private readonly buildPane = viewChild<ElementRef<HTMLElement>>('buildPane');

  constructor() {
    interval(1000)
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.now.set(Date.now()));
    effect(() => {
      this.transcript();
      const pane = this.outputPane()?.nativeElement;
      if (pane) requestAnimationFrame(() => (pane.scrollTop = pane.scrollHeight));
    });
    effect(() => {
      this.buildOutput();
      const pane = this.buildPane()?.nativeElement;
      if (pane) requestAnimationFrame(() => (pane.scrollTop = pane.scrollHeight));
    });
  }

  protected elapsed(): string {
    const startedIso = this.run()?.stepStartedAt;
    const started = startedIso ? Date.parse(startedIso) : Number.NaN;
    if (Number.isNaN(started)) return '';
    const seconds = Math.max(0, Math.round((this.now() - started) / 1000));
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  }

  protected stop(): void {
    void this.pipelines.stop(this.cardId());
  }

  protected back(): void {
    this.board.openCard(this.cardId());
  }

  protected toolArgs(args: unknown): string {
    if (args === undefined || args === null) return '';
    const text = typeof args === 'string' ? args : JSON.stringify(args);
    return text.length > 160 ? text.slice(0, 157) + '…' : text;
  }

  protected toolResult(entry: RunTranscriptEntry & { kind: 'tool' }): string {
    const content = entry.result?.content ?? '';
    const firstLine = content.split('\n').find((line) => line.trim() !== '') ?? '';
    return firstLine.length > 200 ? firstLine.slice(0, 197) + '…' : firstLine;
  }

  protected outcomeLabel(outcome: RunOutcome): string {
    return outcome.status === 'failed'
      ? `the run failed${outcome.error ? ' — ' + outcome.error : ''}`
      : 'the run completed';
  }
}
