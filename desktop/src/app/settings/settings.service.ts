import { Injectable, computed, effect, inject, signal } from '@angular/core';

import { EventsClient } from '../core/events/events-client';
import { ShellService } from '../shell/shell.service';

/**
 * Global app settings (the server's `/settings`): currently the model the
 * runtime loads for planner/coder turns. The shell's model badge reads the
 * live value; the provider endpoint stays opencode's own config.
 */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly events = inject(EventsClient);
  private readonly shell = inject(ShellService);

  private readonly draft = signal<string | null>(null);

  /** The editable field: '' until a load/save gives it the server's value. */
  readonly model = computed(() => this.draft() ?? '');
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly saved = signal(false);

  constructor() {
    // Load whenever the server link comes up (boot and re-attaches).
    effect(() => {
      if (this.events.connected()) void this.load();
    });
  }

  /** Pulls the server's settings into the local draft + shell badge. */
  async load(): Promise<void> {
    const base = this.events.serverBase;
    if (base === null) return;
    this.loading.set(true);
    try {
      const response = await fetch(`${base}/settings`);
      if (!response.ok) return;
      const body = (await response.json()) as { model?: unknown };
      if (typeof body.model === 'string') {
        this.draft.set(body.model);
        this.shell.model.set(body.model);
      }
    } catch {
      // Offline: keep whatever the shell shows.
    } finally {
      this.loading.set(false);
    }
  }

  setDraft(model: string): void {
    this.draft.set(model);
    this.saved.set(false);
  }

  async save(): Promise<boolean> {
    const base = this.events.serverBase;
    if (base === null) {
      this.error.set('no server attached');
      return false;
    }
    this.saving.set(true);
    this.error.set(null);
    try {
      const response = await fetch(`${base}/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.draft()?.trim() || null }),
      });
      if (!response.ok) {
        this.error.set(`the server refused the settings (${response.status})`);
        return false;
      }
      const body = (await response.json()) as { model?: unknown };
      const model = typeof body.model === 'string' ? body.model : '';
      this.draft.set(model);
      this.shell.model.set(model === '' ? 'default' : model);
      this.saved.set(true);
      return true;
    } catch {
      this.error.set('could not reach the server');
      return false;
    } finally {
      this.saving.set(false);
    }
  }
}
