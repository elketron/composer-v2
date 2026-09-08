// The event-store compatibility facade (SRV-009): the one object the bus,
// the boot, and the settings routes use. Its internals are a database
// lifecycle, an event-log repository, and a settings repository — each
// its own responsibility — composed here so the public surface stays stable.

import type { EventEnvelope } from '../wire/envelope.js';
import type { ComposerSettings, SettingsPatch } from './settings.js';

const moduleExtension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
const { ComposerDatabase } = await import(`./database.${moduleExtension}`) as typeof import('./database.js');
const { EventRepository } = await import(`./event-repository.${moduleExtension}`) as typeof import('./event-repository.js');
const { SettingsRepository } = await import(`./settings-repository.${moduleExtension}`) as typeof import('./settings-repository.js');

export class EventStore {
  private readonly database = new ComposerDatabase();
  private readonly events = new EventRepository(this.database);
  private readonly settings = new SettingsRepository(this.database);

  async connect(dir: string): Promise<void> {
    await this.database.connect(dir);
    await this.settings.load();
  }

  async append(envelope: EventEnvelope, ephemeral: boolean): Promise<number> {
    return this.events.append(envelope, ephemeral);
  }

  async replay(projectId: string): Promise<EventEnvelope[]> {
    return this.events.replay(projectId);
  }

  async replayGlobal(): Promise<EventEnvelope[]> {
    return this.events.replayGlobal();
  }

  async projectIds(): Promise<string[]> {
    return this.events.projectIds();
  }

  async getSettings(): Promise<ComposerSettings> {
    return this.settings.get();
  }

  async putSettings(patch: SettingsPatch): Promise<ComposerSettings> {
    return this.settings.put(patch);
  }

  async close(): Promise<void> {
    await this.database.close();
  }
}