import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, viewChild } from '@angular/core';

import { PaletteService } from './palette.service';

/**
 * The global command palette overlay (Ctrl/Cmd+K): a query input over a
 * ranked result list. Arrow keys move the active entry, Enter runs it,
 * Escape and the backdrop close; the input takes focus on open.
 */
@Component({
  selector: 'app-palette',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './palette.component.html',
  styleUrl: './palette.component.scss',
  host: {
    '(document:keydown.control.k)': 'onShortcut($event)',
    '(document:keydown.meta.k)': 'onShortcut($event)',
    '(document:keydown.escape)': 'onDocumentEscape()',
  },
})
export class PaletteComponent {
  protected readonly palette = inject(PaletteService);

  private readonly input = viewChild<ElementRef<HTMLInputElement>>('search');

  constructor() {
    // View effects run after the template pass, so the input exists by the
    // time the palette opens.
    effect(() => {
      if (!this.palette.isOpen()) return;
      this.input()?.nativeElement.focus();
    });
  }

  protected onShortcut(event: Event): void {
    event.preventDefault();
    this.palette.toggle();
  }

  // Escape closes the palette even when the focus left the input; the
  // input-level handler covers the normal (focused) path.
  protected onDocumentEscape(): void {
    if (this.palette.isOpen()) this.palette.close();
  }

  protected onKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.palette.move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.palette.move(-1);
        break;
      case 'Enter':
        event.preventDefault();
        void this.palette.executeAt();
        break;
      case 'Escape':
        event.preventDefault();
        this.palette.close();
        break;
    }
  }
}
