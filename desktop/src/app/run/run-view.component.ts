import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ElementRef, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { LucideAngularModule, ArrowLeft, Bot, Square, Wrench } from 'lucide-angular';
import { interval } from 'rxjs';

import { RunProgress, RunOutcome, runElapsed } from '../core/models/pipeline.models';
import { Card } from '../core/models/board.models';
import { RunTranscriptEntry, PipelineService } from '../pipelines/pipeline.service';
import { BoardService } from '../board/board.service';
import { ShellService } from '../shell/shell.service';

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
  imports: [LucideAngularModule],
  templateUrl: './run-view.component.html',
  styleUrl: './run-view.component.scss',
})
export class RunViewComponent {
  private readonly board = inject(BoardService);
  private readonly pipelines = inject(PipelineService);
  private readonly router = inject(Router);
  private readonly shell = inject(ShellService);

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

  /** The active/historical agent session the output pane reads. */
  protected readonly session = computed(() => {
    const id = this.sessionId();
    if (id === undefined) return undefined;
    return this.pipelines.agentSessions().find((session) => session.sessionId === id);
  });

  protected readonly sessionUsage = computed(() => this.session()?.usage);
  protected readonly sessionFiles = computed(() => this.session()?.files ?? []);

  protected readonly transcript = computed<readonly RunTranscriptEntry[]>(() =>
    this.pipelines.transcriptFor(this.sessionId()),
  );

  protected readonly buildOutput = computed(() => this.pipelines.commandOutputFor(this.cardId()));

  /** The card's assigned pipeline (its steps are the pipeline progress, not agent todos). */
  protected readonly runPipelineOf = computed(() => {
    const cardState = this.card();
    if (cardState === undefined) return undefined;
    return this.pipelines.pipelineById(cardState.pipelineId);
  });

  /** The assigned pipeline's steps with the card's per-step state. */
  protected readonly steps = computed(() => {
    const cardState = this.card();
    const pipeline = this.runPipelineOf();
    if (cardState === undefined || pipeline === undefined) return [];
    return pipeline.steps
      .filter((step) => !step.terminal)
      .map((step) => ({
        step,
        status: cardState.stepStates[step.id] ?? 'pending',
      }));
  });

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
    return runElapsed(this.run(), this.now());
  }

  protected stop(): void {
    void this.pipelines.stop(this.cardId());
  }

  protected back(): void {
    this.board.openCard(this.cardId());
    const projectId = this.shell.activeTabId();
    if (projectId) void this.router.navigate(['/projects', projectId, 'coding', 'board']);
  }

  protected toolArgs(args: unknown): string {
    if (args === undefined || args === null) return '';
    const text = typeof args === 'string' ? args : JSON.stringify(args);
    return text.length > 160 ? text.slice(0, 157) + '…' : text;
  }

  /** Formats a dollar cost (a zero cost is real, not "missing"). */
  protected costLabel(cost: number): string {
    return `$${cost.toFixed(4)}`;
  }

  protected fileAdditions(): number {
    return this.sessionFiles().reduce((total, file) => total + file.additions, 0);
  }

  protected fileDeletions(): number {
    return this.sessionFiles().reduce((total, file) => total + file.deletions, 0);
  }

  protected toolResult(entry: RunTranscriptEntry & { kind: 'tool' }): string {
    const content = entry.result?.content ?? '';
    const firstLine = content.split('\n').find((line) => line.trim() !== '') ?? '';
    return firstLine.length > 200 ? firstLine.slice(0, 197) + '…' : firstLine;
  }

  protected outcomeLabel(outcome: RunOutcome): string {
    switch (outcome.status) {
      case 'failed':
        return `the run failed${outcome.error ? ' — ' + outcome.error : ''}`;
      case 'returned':
        return `${outcome.outcome ?? 'changes needed'}${outcome.feedback ? ' — ' + outcome.feedback : ''}`;
      case 'cancelled':
        return 'the run was cancelled';
      default:
        return 'the run completed';
    }
  }
}
