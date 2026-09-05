import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { Bot, ExternalLink } from 'lucide-angular';

import { ShellService } from '../shell/shell.service';
import { PipelineService } from './pipeline.service';

/**
 * The coding tab (S4): the cards an agent session is working, newest
 * first. Transcript UI is deferred — the runtime's own session is the
 * source of truth and opencode can attach to it directly; this view is
 * the pointer, not a second transcript.
 */
@Component({
  selector: 'app-coding-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule],
  templateUrl: './coding-view.component.html',
  styleUrl: './coding-view.component.scss',
})
export class CodingViewComponent {
  private readonly shell = inject(ShellService);
  private readonly pipelines = inject(PipelineService);

  protected readonly projectId = computed(() => this.shell.activeTabId());
  protected readonly sessions = computed(() => this.pipelines.agentSessions());
  protected readonly hasRunning = computed(() => this.sessions().some((s) => s.status === 'running'));

  protected readonly icons = { bot: Bot, attach: ExternalLink };

  protected cardLabel(cardId: string): string {
    return cardId === '' ? '—' : cardId;
  }
}
