import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { Router } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { EyeOff, Lock, MessageSquare } from 'lucide-angular';

import { AgePipe } from '../core/age.pipe';
import { Card } from '../core/models/board.models';
import { runIcon, runLabel } from '../core/models/pipeline.models';
import { PipelineService } from '../pipelines/pipeline.service';
import { ShellService } from '../shell/shell.service';

/**
 * Card anatomy (design.md §3.2): type icon + accent bar, id, tags, title,
 * two-line snippet, assignee + age, session link + file stats, dependency
 * lock chip, run chip while a pipeline works the card (pulsing at a gate),
 * and the hidden-stage/step line when execution is inside a stage that has
 * no column. Click or Enter opens the card in the detail panel.
 */
@Component({
  selector: 'app-board-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, AgePipe],
  templateUrl: './board-card.component.html',
  styleUrl: './board-card.component.scss',
  host: {
    tabindex: '0',
    role: 'button',
    '(click)': 'activate()',
    '(keydown.enter)': 'activate()',
  },
})
export class BoardCardComponent {
  private readonly pipelines = inject(PipelineService);
  private readonly router = inject(Router);
  private readonly shell = inject(ShellService);

  readonly card = input.required<Card>();
  readonly blocked = input(false);

  /** The user asked to open this card in the detail panel. */
  readonly activated = output<Card>();

  protected readonly meta = computed(() => this.card().meta);

  /** The card's pipeline run, if any (the board's progress projection). */
  protected readonly run = computed(() => this.pipelines.runForCard(this.card().id));

  protected readonly working = computed(() => this.run()?.status === 'running');

  /** The assigned pipeline (its steps label the hidden-step line). */
  protected readonly pipeline = computed(() => this.pipelines.pipelineById(this.card().pipelineId));

  /**
   * Execution inside a hidden step: the card stays in its previous visible
   * swimlane and this line shows where the run actually is. While a run
   * works the card, the running step is the one that may be hidden; idle
   * cards fall back to their own position.
   */
  protected readonly hiddenStepLabel = computed(() => {
    const pipeline = this.pipeline();
    if (pipeline === undefined) return null;
    const stepId = this.run()?.stepId ?? this.card().stepId;
    return pipeline.hiddenStepLabel(stepId);
  });

  protected readonly runLabel = computed(() => runLabel(this.run()));

  protected readonly runIcon = computed(() => runIcon(this.run()));

  protected readonly hasStats = computed(() => {
    const stats = this.card().fileStats;
    return stats !== undefined && (stats.added > 0 || stats.removed > 0);
  });

  protected readonly lockTooltip = computed(
    () => `blocked by ${this.card().blockedBy.join(', ')}`,
  );

  protected readonly icons = { lock: Lock, session: MessageSquare, hidden: EyeOff };

  protected activate(): void {
    this.activated.emit(this.card());
  }

  /** The run chip opens the full-page run view (not the card panel). */
  protected openRun(event: MouseEvent): void {
    event.stopPropagation();
    const card = this.card();
    const projectId = this.shell.activeTabId();
    if (projectId) void this.router.navigate(['/projects', projectId, 'coding', 'run', card.id]);
  }
}
