import { ChangeDetectionStrategy, Component, inject } from "@angular/core";

import { AssistantService } from "./assistant/assistant.service";
import { BoardService } from "./board/board.service";
import { DiagramService } from "./canvas/diagram.service";
import { ConfirmDialogComponent } from "./core/confirm/confirm-dialog.component";
import { DirectoryPickerComponent } from "./core/directory-picker/directory-picker.component";
import { EventsClient } from "./core/events/events-client";
import { PaletteComponent } from "./core/palette/palette.component";
import { PlanService } from "./plan/plan.service";
import { SettingsService } from "./settings/settings.service";
import { ShellComponent } from "./shell/shell.component";
import { ShellService } from "./shell/shell.service";

@Component({
  selector: "app-root",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ShellComponent,
    ConfirmDialogComponent,
    DirectoryPickerComponent,
    PaletteComponent,
  ],
  templateUrl: "./app.html",
})
export class App {
  // Composition root: construct the stream-folding services, then open the
  // stream. Each fold subscribes in its own constructor, so connecting only
  // after they all exist means the startup snapshot lands on every fold —
  // no missing-first-event ordering bug to work around. Every service that
  // folds events must be injected here: a lazy one (constructed only when
  // its route first loads) misses the snapshot entirely.
  private readonly events = inject(EventsClient);
  private readonly shell = inject(ShellService);
  private readonly board = inject(BoardService);
  private readonly plan = inject(PlanService);
  private readonly assistant = inject(AssistantService);
  private readonly settings = inject(SettingsService);
  private readonly diagrams = inject(DiagramService);

  constructor() {
    this.events.connect();
  }
}
