import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { ProjectTabsComponent } from './project-tabs.component';
import { StatusStripComponent } from './status-strip.component';
import { TopbarComponent } from './topbar.component';

/**
 * Global desktop shell. The open-projects tab strip sits under the top
 * bar; project workflow navigation is nested inside the project workspace
 * so global views such as Dashboard use the full width.
 */
@Component({
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, TopbarComponent, ProjectTabsComponent, StatusStripComponent],
  templateUrl: './shell.component.html',
  styleUrl: './shell.component.scss',
})
export class ShellComponent {}
