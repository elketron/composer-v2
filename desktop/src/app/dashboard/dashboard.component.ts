import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  Archive,
  FolderGit2,
  LucideAngularModule,
  Plus,
  RefreshCw,
  RotateCcw,
} from 'lucide-angular';

import { AgePipe } from '../core/age.pipe';
import { ConfirmService } from '../core/confirm/confirm.service';
import { ShellService } from '../shell/shell.service';
import { DashboardService } from './dashboard.service';

@Component({
  selector: 'app-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AgePipe, LucideAngularModule],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
  host: { '(window:focus)': 'refresh()' },
})
export class DashboardComponent {
  private readonly shell = inject(ShellService);
  private readonly router = inject(Router);
  private readonly dashboard = inject(DashboardService);
  private readonly confirm = inject(ConfirmService);

  protected readonly projects = this.shell.activeProjects;
  protected readonly archivedProjects = this.shell.archivedProjects;
  protected readonly showArchived = signal(false);
  protected readonly busyIds = signal<ReadonlySet<string>>(new Set());
  protected readonly error = signal<string | null>(null);
  protected readonly healthLoading = this.dashboard.loading;
  protected readonly healthError = this.dashboard.error;
  protected readonly actionItems = computed(() =>
    this.dashboard.projects().flatMap((project) => [
      ...project.waitingApprovals.map((run) => ({ ...run, kind: 'approval' as const, project })),
      ...project.failedRuns.map((run) => ({ ...run, kind: 'failed' as const, project })),
    ]),
  );
  protected readonly icons = {
    project: FolderGit2,
    plus: Plus,
    archive: Archive,
    restore: RotateCcw,
    refresh: RefreshCw,
  };

  protected createProject(): void {
    void this.shell.addTab();
  }

  protected openProject(projectId: string): void {
    void this.router.navigateByUrl(this.shell.workspaceUrl(projectId));
  }

  protected refresh(): void {
    void this.dashboard.refresh();
  }

  protected healthFor(projectId: string) {
    return this.dashboard.forProject(projectId);
  }

  protected openRun(projectId: string, cardId: string): void {
    void this.router.navigate(['/projects', projectId, 'coding', 'run', cardId]);
  }

  protected async archiveProject(projectId: string, name: string): Promise<void> {
    const confirmed = await this.confirm.confirm({
      title: `Archive ${name}?`,
      detail: 'Its Composer history and linked directory will be preserved.',
      confirmLabel: 'archive',
      danger: true,
    });
    if (!confirmed) {
      return;
    }
    this.setBusy(projectId, true);
    this.error.set(await this.shell.archiveProject(projectId));
    if (!this.error()) await this.dashboard.refresh();
    this.setBusy(projectId, false);
  }

  protected async restoreProject(projectId: string): Promise<void> {
    this.setBusy(projectId, true);
    this.error.set(await this.shell.restoreProject(projectId));
    if (!this.error()) await this.dashboard.refresh();
    this.setBusy(projectId, false);
  }

  private setBusy(projectId: string, busy: boolean): void {
    this.busyIds.update((ids) => {
      const next = new Set(ids);
      if (busy) next.add(projectId);
      else next.delete(projectId);
      return next;
    });
  }
}
