// The settings repository (SRV-009): global app settings (config, not domain
// history) — outside the event log. The repository owns the normalize-merge
// and the persistence, over the shared database lifecycle.

import type { ComposerDatabase } from './database.js';
import type { ComposerSettings, SettingsPatch } from './settings.js';

const moduleExtension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
const { applySettingsPatch, normalizeStoredSettings } = await import(
  `./settings.${moduleExtension}`
) as typeof import('./settings.js');

export class SettingsRepository {
  private settings: ComposerSettings = {};
  private readonly database: ComposerDatabase;

  constructor(database: ComposerDatabase) {
    this.database = database;
  }

  async load(): Promise<void> {
    const [rows] = await this.database.client.query<{ model?: string | null; models?: Record<string, string> | null }[][]>(
      'SELECT model, models FROM settings:global;',
    );
    this.settings = normalizeStoredSettings(rows?.[0]);
  }

  /** Global app settings, cached hot (the runner/planner read per spawn). */
  async get(): Promise<ComposerSettings> {
    return {
      ...(this.settings.model !== undefined ? { model: this.settings.model } : {}),
      ...(this.settings.models !== undefined ? { models: { ...this.settings.models } } : {}),
    };
  }

  /** Merges a validated patch and persists it (null clears a field;
   * a `models` patch replaces the whole per-agent map). */
  async put(patch: SettingsPatch): Promise<ComposerSettings> {
    this.settings = applySettingsPatch(this.settings, patch);
    await this.database.client.query('UPSERT settings:global SET model = $model, models = $models;', {
      model: this.settings.model ?? null,
      models: this.settings.models ?? null,
    });
    return this.get();
  }
}