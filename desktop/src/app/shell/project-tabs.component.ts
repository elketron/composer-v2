import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';

import { ShellService } from './shell.service';

/**
 * The open-projects tab strip (browser-tab semantics): one tab per open
 * project, click switches (the reuse strategy keeps every tab's views
 * alive), × closes (closing the active one navigates to the last
 * remaining tab, or the dashboard when none is left).
 */
@Component({
  selector: 'app-project-tabs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './project-tabs.component.html',
  styleUrl: './project-tabs.component.scss',
})
export class ProjectTabsComponent {
  private readonly shell = inject(ShellService);
  private readonly router = inject(Router);

  protected readonly tabs = this.shell.openTabs;
  protected readonly activeId = this.shell.activeTabId;

  protected open(id: string): void {
    void this.router.navigateByUrl(this.shell.openProject(id));
  }

  protected async close(id: string, event: MouseEvent): Promise<void> {
    event.stopPropagation();
    const url = this.shell.beginTabClose(id);
    if (url === null) return; // an inactive tab closed invisibly
    const navigated = await this.router.navigateByUrl(url).catch(() => false);
    this.shell.completeTabClose(navigated !== false);
  }
}
