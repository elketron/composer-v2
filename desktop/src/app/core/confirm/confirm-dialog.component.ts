import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  viewChild,
} from '@angular/core';

import { ConfirmService } from './confirm.service';

/**
 * The global confirmation surface: renders whenever a destructive action
 * is awaiting a decision. Escape cancels; the safe (cancel) button takes
 * focus so an accidental Enter never confirms, Tab cycles within the
 * dialog while it is open, and the trigger regains focus on close.
 */
@Component({
  selector: 'app-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './confirm-dialog.component.html',
  styleUrl: './confirm-dialog.component.scss',
  host: {
    '(document:keydown.escape)': 'cancel()',
    '(document:keydown.tab)': 'cycleFocus($event)',
    '(document:keydown.shift.tab)': 'cycleFocus($event)',
  },
})
export class ConfirmDialogComponent {
  protected readonly confirmService = inject(ConfirmService);

  private readonly cancelButton = viewChild<ElementRef<HTMLButtonElement>>('cancelButton');
  private readonly acceptButton = viewChild<ElementRef<HTMLButtonElement>>('accept');

  protected readonly request = this.confirmService.current;

  protected readonly dangerClass = computed(() =>
    this.request()?.danger === true ? 'danger' : '',
  );

  constructor() {
    // View effects run after the template pass, so the dialog's DOM exists
    // by the time the open request lands. Focus lands on the non-destructive
    // choice: Enter repeats the last action, which must never archive.
    effect(() => {
      if (this.request() === null) return;
      this.cancelButton()?.nativeElement.focus();
    });
  }

  /** Modal focus trap: Tab/Shift+Tab cycle the dialog's buttons only. */
  protected cycleFocus(event: Event): void {
    if (this.request() === null) return;
    event.preventDefault();
    const focusable = [this.cancelButton()?.nativeElement, this.acceptButton()?.nativeElement].filter(
      (button): button is HTMLButtonElement => button !== undefined,
    );
    if (focusable.length === 0) return;
    const step = event instanceof KeyboardEvent && event.shiftKey ? -1 : 1;
    const current = focusable.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      current === -1
        ? step === -1
          ? focusable.length - 1
          : 0
        : (current + step + focusable.length) % focusable.length;
    focusable[next]?.focus();
  }

  protected decide(confirmed: boolean): void {
    this.confirmService.resolve(confirmed);
  }

  protected cancel(): void {
    if (this.request() !== null) this.confirmService.resolve(false);
  }
}
