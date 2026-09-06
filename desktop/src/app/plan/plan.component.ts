import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';

import { ShellService } from '../shell/shell.service';
import { PlanChatComponent } from './plan-chat.component';
import { PlanDocumentComponent } from './plan-document.component';
import { PlanService } from './plan.service';

/**
 * The plan view: the planning chat beside the plan document on wide
 * windows; below the width threshold the panes become tabs (one visible at
 * a time, full width) so neither is squeezed into unreadability.
 */
@Component({
  selector: 'app-plan',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PlanChatComponent, PlanDocumentComponent],
  templateUrl: './plan.component.html',
  styleUrl: './plan.component.scss',
})
export class PlanComponent {
  private readonly plan = inject(PlanService);
  private readonly shell = inject(ShellService);

  protected readonly session = this.plan.session;
  protected readonly status = this.plan.status;

  /** Below this window width the two panes can no longer share the row. */
  private static readonly NARROW_QUERY = '(max-width: 999px)';

  private readonly media =
    typeof window.matchMedia === 'function' ? window.matchMedia(PlanComponent.NARROW_QUERY) : null;

  protected readonly narrow = signal(this.media?.matches ?? false);
  protected readonly tab = signal<'chat' | 'doc'>('chat');

  protected newSession(): void {
    this.plan.requestNewSession();
  }

  protected showTab(tab: 'chat' | 'doc'): void {
    this.tab.set(tab);
  }

  constructor() {
    effect(() => this.plan.setProject(this.shell.activeTabId()));
    this.media?.addEventListener('change', (event) => {
      this.narrow.set(event.matches);
      // Back to side-by-side: both panes visible again.
      if (!event.matches) this.tab.set('chat');
    });
  }
}
