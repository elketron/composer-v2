import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { AssistantService } from './assistant/assistant.service';
import { BoardService } from './board/board.service';
import { ConfirmDialogComponent } from './core/confirm/confirm-dialog.component';
import { DirectoryPickerComponent } from './core/directory-picker/directory-picker.component';
import { EventsClient } from './core/events/events-client';
import { PaletteComponent } from './core/palette/palette.component';
import { PlanService } from './plan/plan.service';
import { SettingsService } from './settings/settings.service';
import { ShellComponent } from './shell/shell.component';
import { ShellService } from './shell/shell.service';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ShellComponent, ConfirmDialogComponent, DirectoryPickerComponent, PaletteComponent],
  templateUrl: './app.html',
})
export class App {
  // Every stream-folding service must exist before the first event lands —
  // they are instantiated lazily on first injection, but events$ is a plain
  // Subject: a service constructed later (e.g. PlanService when the Plan view
  // first opens) would miss the startup snapshot. Inject them all here so
  // all folds are subscribed before the stream connects. SettingsService
  // counts too: its connected-effect pulls `/settings` at boot, which keeps
  // the shell's model badge truthful before any view is visited.
  private readonly events = inject(EventsClient);
  private readonly shell = inject(ShellService);
  private readonly board = inject(BoardService);
  private readonly plan = inject(PlanService);
  private readonly assistant = inject(AssistantService);
  private readonly settings = inject(SettingsService);
}
