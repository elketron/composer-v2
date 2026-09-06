import { Injectable, signal } from '@angular/core';

/**
 * The one in-app confirmation surface (no native dialogs): destructive
 * actions await `confirm()` and the shell renders `ConfirmDialogComponent`
 * while a request is pending. The promise settles on the user's choice;
 * Escape and the backdrop resolve `false`.
 */
export interface ConfirmRequest {
  title: string;
  detail?: string;
  confirmLabel?: string;
  danger?: boolean;
}

interface PendingRequest extends ConfirmRequest {
  resolve: (confirmed: boolean) => void;
}

@Injectable({ providedIn: 'root' })
export class ConfirmService {
  private readonly pending = signal<PendingRequest | null>(null);

  /** The open request, or null when nothing awaits a decision. */
  readonly current = this.pending.asReadonly();

  /** The element to hand focus back to when the dialog settles. */
  private opener: HTMLElement | null = null;

  /** Opens the dialog; resolves once the user decides (Escape → false). */
  confirm(request: ConfirmRequest): Promise<boolean> {
    this.opener =
      typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    // A second request supersedes the first; the abandoned caller is
    // cancelled rather than left dangling behind a dialog it can't see.
    this.current()?.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.pending.set({ ...request, resolve });
    });
  }

  /** Settles the open promise; called by the dialog component only. */
  resolve(confirmed: boolean): void {
    const pending = this.pending();
    if (pending === null) return;
    this.pending.set(null);
    pending.resolve(confirmed);
    // Focus returns to the trigger, not to <body>.
    this.opener?.focus();
    this.opener = null;
  }
}
