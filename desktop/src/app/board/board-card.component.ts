import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { Router } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { Bot, Lock, MessageSquare, SquareCheck, Terminal } from 'lucide-angular';

import { AgePipe } from '../core/age.pipe';
import { Card } from '../core/models/board.models';
import { PipelineService } from '../pipelines/pipeline.service';
import { ShellService } from '../shell/shell.service';

/**
 * Card anatomy (design.md §3.2): type icon + accent bar, id, tags, title,
 * two-line snippet, assignee + age, session link + file stats, dependency
 * lock chip, run chip while a pipeline works the card (pulsing at a gate).
 * Click or Enter opens the card in the detail panel.
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
  protected readonly working = computed(() => this.card().isWorking());

  /** The card's pipeline run, if any (the board's progress projection). */
  protected readonly run = computed(() => this.pipelines.runForCard(this.card().id));

  protected readonly runLabel = computed(() => {
    const run = this.run();
    if (run === undefined) return null;
    switch (run.stepKind) {
      case 'agent':
        return 'agent';
      case 'command':
        return 'command';
      case 'human':
        return 'approval';
      default:
        return 'queued';
    }
  });

  protected readonly runIcon = computed(() => {
    switch (this.run()?.stepKind) {
      case 'command':
        return Terminal;
      case 'human':
        return SquareCheck;
      default:
        return Bot;
    }
  });

  protected readonly hasStats = computed(() => {
    const stats = this.card().fileStats;
    return stats !== undefined && (stats.added > 0 || stats.removed > 0);
  });

  protected readonly lockTooltip = computed(
    () => `blocked by ${this.card().blockedBy.join(', ')}`,
  );

  protected readonly icons = { lock: Lock, session: MessageSquare };

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
