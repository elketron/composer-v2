import { Injectable, computed, effect, inject, signal } from '@angular/core';

import { EventsClient } from '../core/events/events-client';
import { RestClient } from '../core/rest';

/**
 * Global app settings (the server's `/settings`): the default model plus
 * per-agent overrides (planner, coder, the pipeline workers, and any
 * custom agent kind). The shell's model badge shows the default (via
 * `effectiveModel`); the pipeline editor's agent picker offers the known
 * kinds. Provider endpoints and credentials live in Pi's agent config
 * (~/.pi/agent) — composer only persists the model ids.
 */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly events = inject(EventsClient);
  private readonly rest = inject(RestClient);

  private readonly modelDraft = signal<string | null>(null);
  private readonly modelsDraft = signal<Record<string, string> | null>(null);
  private readonly savedModel = signal('');
  private readonly savedModels = signal<Record<string, string>>({});

  readonly availableModels = signal<readonly string[]>([]);

  /** The editable default-model field: '' until a load/save gives it a value. */
  readonly model = computed(() => this.modelDraft() ?? this.savedModel());
  /** The saved default model the shell badge shows ('default' when unset). */
  readonly effectiveModel = computed(() => this.savedModel() || 'default');
  /** The per-agent overrides (kind → model), as last edited. */
  readonly models = computed(() => this.modelsDraft() ?? this.savedModels());
  /** The known agent kinds: the shipped ones plus anything with an override. */
  readonly agentKinds = computed(() => [
    ...new Set(['planner', 'coder', 'tester', 'reviewer', 'security', ...Object.keys(this.models())]),
  ]);

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

  /** Pulls the server's settings into the local draft. */
  async load(): Promise<void> {
    if (this.rest.serverBase === null) return;
    this.loading.set(true);
    try {
      const response = await this.rest.get<{ model?: unknown; models?: unknown }>('/settings');
      if (response === null || !response.ok) return;
      const model = typeof response.body.model === 'string' ? response.body.model : '';
      const saved: Record<string, string> = {};
      if (response.body.models !== null && typeof response.body.models === 'object') {
        for (const [kind, value] of Object.entries(response.body.models as Record<string, unknown>)) {
          if (typeof value === 'string' && value !== '') saved[kind] = value;
        }
      }
      this.savedModel.set(model);
      this.savedModels.set(saved);
      this.modelDraft.set(null);
      this.modelsDraft.set(null);
    } finally {
      this.loading.set(false);
    }
    await this.loadModels();
  }

  private async loadModels(): Promise<void> {
    const response = await this.rest.get<{ models?: unknown }>('/models');
    if (response === null || !response.ok) return;
    if (!Array.isArray(response.body.models)) return;
    this.availableModels.set(
      response.body.models.filter((model): model is string => typeof model === 'string' && model !== ''),
    );
  }

  setModel(value: string): void {
    this.modelDraft.set(value);
    this.saved.set(false);
  }

  setAgentModel(kind: string, value: string): void {
    const map = { ...this.models() };
    if (value.trim() === '') delete map[kind];
    else map[kind] = value;
    this.modelsDraft.set(map);
    this.saved.set(false);
  }

  /** Adds a row for a custom agent kind (idempotent). */
  addAgent(kindRaw: string): boolean {
    const kind = kindRaw.trim().toLowerCase();
    if (kind === '') return false;
    if (kind in this.models()) return true;
    this.modelsDraft.set({ ...this.models(), [kind]: '' });
    this.saved.set(false);
    return true;
  }

  async save(): Promise<boolean> {
    if (this.rest.serverBase === null) {
      this.error.set('no server attached');
      return false;
    }
    this.saving.set(true);
    this.error.set(null);
    try {
      const models: Record<string, string> = {};
      for (const [kind, value] of Object.entries(this.models())) {
        const trimmed = value.trim();
        if (trimmed !== '') models[kind] = trimmed;
      }
      const response = await this.rest.put<{ model?: unknown; models?: unknown }>('/settings', {
        model: this.model().trim() || null,
        models,
      });
      if (response === null) {
        this.error.set('could not reach the server');
        return false;
      }
      if (!response.ok) {
        this.error.set(`the server refused the settings (${response.status})`);
        return false;
      }
      const model = typeof response.body.model === 'string' ? response.body.model : '';
      const saved: Record<string, string> = {};
      if (response.body.models !== null && typeof response.body.models === 'object') {
        for (const [kind, value] of Object.entries(response.body.models as Record<string, unknown>)) {
          if (typeof value === 'string' && value !== '') saved[kind] = value;
        }
      }
      this.savedModel.set(model);
      this.savedModels.set(saved);
      this.modelDraft.set(null);
      this.modelsDraft.set(null);
      this.saved.set(true);
      return true;
    } finally {
      this.saving.set(false);
    }
  }
}
