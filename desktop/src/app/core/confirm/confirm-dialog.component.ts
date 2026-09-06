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
 * is awaiting a decision. Escape cancels; the confirming button takes
 * focus so Enter confirms and keyboard users are never stranded.
 */
@Component({
  selector: 'app-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './confirm-dialog.component.html',
  styleUrl: './confirm-dialog.component.scss',
  host: { '(document:keydown.escape)': 'cancel()' },
})
export class ConfirmDialogComponent {
  protected readonly confirmService = inject(ConfirmService);

  private readonly acceptButton = viewChild<ElementRef<HTMLButtonElement>>('accept');

  protected readonly request = this.confirmService.current;

  protected readonly dangerClass = computed(() =>
    this.request()?.danger === true ? 'danger' : '',
  );

  constructor() {
    // View effects run after the template pass, so the dialog's DOM exists
    // by the time the open request lands.
    effect(() => {
      if (this.request() === null) return;
      this.acceptButton()?.nativeElement.focus();
    });
  }

  protected decide(confirmed: boolean): void {
    this.confirmService.resolve(confirmed);
  }

  protected cancel(): void {
    if (this.request() !== null) this.confirmService.resolve(false);
  }
}
