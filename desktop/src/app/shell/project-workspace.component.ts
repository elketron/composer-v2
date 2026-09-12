import { ChangeDetectionStrategy, Component, effect, inject } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import {
  ActivatedRoute,
  NavigationEnd,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { filter, map } from 'rxjs';

import { LeftRailComponent } from './left-rail.component';
import { ShellService } from './shell.service';

/** Hosts one project's workflow tabs and the selected workflow's view rail. */
@Component({
  selector: 'app-project-workspace',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LeftRailComponent, RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './project-workspace.component.html',
  styleUrl: './project-workspace.component.scss',
})
export class ProjectWorkspaceComponent {
  private readonly shell = inject(ShellService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly projectId = toSignal(
    this.route.paramMap.pipe(map((params) => params.get('projectId') ?? '')),
    { initialValue: this.route.snapshot.paramMap.get('projectId') ?? '' },
  );

  constructor() {
    effect(() => {
      const projectId = this.projectId();
      if (!projectId) return;
      if (this.shell.project(projectId)?.archivedAt) {
        void this.router.navigateByUrl('/dashboard');
        return;
      }
      this.shell.selectProject(projectId);
    });
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe((event) => {
        // Tab switches reattach this workspace without re-running the
        // route effect: re-assert the active context on every landing.
        const myId = this.projectId();
        if (myId && event.urlAfterRedirects.startsWith(`/projects/${encodeURIComponent(myId)}/`)) {
          this.shell.selectProject(myId);
        }
        this.shell.rememberWorkspaceUrl(event.urlAfterRedirects);
      });
  }
}
