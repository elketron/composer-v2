import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { LeftRailComponent } from './left-rail.component';
import { StatusStripComponent } from './status-strip.component';
import { TopbarComponent } from './topbar.component';

/**
 * Desktop shell layout (docs/frontend/design.md §2): top bar across the top,
 * left rail down the left, active view filling the center, status strip at the
 * bottom of the content column (inside the rail's right edge).
 */
@Component({
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, TopbarComponent, LeftRailComponent, StatusStripComponent],
  templateUrl: './shell.component.html',
  styleUrl: './shell.component.scss',
})
export class ShellComponent {}
