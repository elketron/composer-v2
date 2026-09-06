import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { filter, map } from 'rxjs';

import { PaletteService } from '../core/palette/palette.service';
import { ShellService } from './shell.service';

/**
 * Global top bar: application destinations, current project context,
 * breadcrumb, and the active model badge.
 *
 * The telemetry badges (calls / elapsed / build) are gone until wired to
 * live data — static placeholders read as real telemetry.
 */
@Component({
  selector: 'app-topbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './topbar.component.html',
  styleUrl: './topbar.component.scss',
})
export class TopbarComponent {
  private readonly shell = inject(ShellService);
  private readonly router = inject(Router);
  private readonly palette = inject(PaletteService);

  protected readonly activeTab = this.shell.activeTab;
  protected readonly model = this.shell.model;

  private readonly currentUrl = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );

  protected readonly inWorkspace = computed(() =>
    (this.currentUrl() ?? '').startsWith('/projects/'),
  );

  private readonly viewName = computed(() => {
    const segments = (this.currentUrl() ?? '').split(/[?#]/, 1)[0].split('/').filter(Boolean);
    if (segments[0] !== 'projects')
      return segments[0] === 'dashboard' ? 'projects' : segments[0] || 'projects';
    const view = segments[3] ?? 'board';
    return view === 'coding' ? 'sessions' : view;
  });

  protected readonly breadcrumb = computed(() => {
    const tab = this.activeTab();
    return this.inWorkspace() && tab
      ? `${tab.name} › coding › ${this.viewName()}`
      : this.viewName();
  });

  protected add(): void {
    void this.shell.addTab();
  }

  protected openPalette(): void {
    this.palette.openPalette();
  }

  protected linkDirectory(id: string, event: Event): void {
    event.stopPropagation();
    void this.shell.linkDirectory(id);
  }

  protected openProject(id: string): void {
    void this.router.navigateByUrl(this.shell.workspaceUrl(id));
  }
}
