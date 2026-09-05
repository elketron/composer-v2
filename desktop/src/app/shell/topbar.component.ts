import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map } from 'rxjs';

import { ShellService } from './shell.service';

/**
 * Top bar (design.md §2): logo, project tabs (+), breadcrumb, and the
 * active model badge on the right.
 *
 * The telemetry badges (calls / elapsed / build) are gone until wired to
 * live data — static placeholders read as real telemetry.
 */
@Component({
  selector: 'app-topbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './topbar.component.html',
  styleUrl: './topbar.component.scss',
})
export class TopbarComponent {
  private readonly shell = inject(ShellService);
  private readonly router = inject(Router);

  protected readonly tabs = this.shell.tabs;
  protected readonly activeTabId = this.shell.activeTabId;
  protected readonly activeTab = this.shell.activeTab;
  protected readonly model = this.shell.model;

  private readonly currentUrl = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );

  private readonly viewName = computed(() => {
    const segment = (this.currentUrl() ?? '').split('?')[0].replace(/^\/+|\/+$/g, '');
    return segment || 'board';
  });

  protected readonly breadcrumb = computed(() => {
    const tab = this.activeTab();
    return tab ? `${tab.name} › ${this.viewName()}` : this.viewName();
  });

  protected add(): void {
    void this.shell.addTab();
  }

  protected linkDirectory(id: string, event: Event): void {
    event.stopPropagation();
    void this.shell.linkDirectory(id);
  }

  protected activate(id: string): void {
    this.shell.activateTab(id);
  }

  protected close(id: string, event: Event): void {
    event.stopPropagation();
    this.shell.closeTab(id);
  }
}
