import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { Bot, ExternalLink } from 'lucide-angular';
import { RouterLink } from '@angular/router';

import { AgePipe } from '../core/age.pipe';
import { ShellService } from '../shell/shell.service';
import { PipelineService } from './pipeline.service';

/**
 * The coding tab: the project's agent-session history, newest first. Each
 * row links to the card's run view (the transcript lives there); a session
 * without a card (planner-adjacent runs) renders without a link. The
 * runtime's own session remains the source of truth — opencode can attach
 * directly; this view is the pointer, not a second transcript.
 */
@Component({
  selector: 'app-coding-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, RouterLink, AgePipe, NgTemplateOutlet],
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

  /** The run view URL for a session's card; null sessions render inert. */
  protected runLink(cardId: string): string[] | null {
    const projectId = this.projectId();
    if (projectId === null || cardId === '') return null;
    return ['/projects', projectId, 'coding', 'run', cardId];
  }
}
