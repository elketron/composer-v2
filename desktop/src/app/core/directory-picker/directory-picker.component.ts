import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ChevronUp, Folder, LucideAngularModule, X } from 'lucide-angular';

import { DirectoryPickerService } from './directory-picker.service';

/** The in-app browser for directories visible to the Composer server. */
@Component({
  selector: 'app-directory-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, LucideAngularModule],
  templateUrl: './directory-picker.component.html',
  styleUrl: './directory-picker.component.scss',
  host: { '(document:keydown.escape)': 'cancel()' },
})
export class DirectoryPickerComponent {
  protected readonly picker = inject(DirectoryPickerService);
  private readonly pathInput = viewChild<ElementRef<HTMLInputElement>>('pathInput');

  protected readonly icons = { folder: Folder, up: ChevronUp, close: X };

  constructor() {
    effect(() => {
      if (this.picker.current() === null) return;
      this.pathInput()?.nativeElement.focus();
    });
  }

  protected cancel(): void {
    if (this.picker.current() !== null) this.picker.cancel();
  }
}
