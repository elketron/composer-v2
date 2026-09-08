// The event-log repository (SRV-009): append, replay, and project listing
// over the shared database lifecycle. The sequence counter and the underlying
// client come from the `ComposerDatabase`.

import type { EventEnvelope } from '../wire/envelope.js';
import type { ComposerDatabase } from './database.js';

const moduleExtension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
const { persistEvent, replayProject, replayGlobalEvents, listProjectIds } = await import(
  `./event-log.${moduleExtension}`
) as typeof import('./event-log.js');

export class EventRepository {
  private readonly database: ComposerDatabase;

  constructor(database: ComposerDatabase) {
    this.database = database;
  }

  /** Persists one event and returns its assigned sequence. */
  async append(envelope: EventEnvelope, ephemeral: boolean): Promise<number> {
    const seq = this.database.nextSeq();
    await persistEvent(this.database.client, envelope, seq, ephemeral);
    return seq;
  }

  /** Replays a project's non-ephemeral events, in emission order. */
  async replay(projectId: string): Promise<EventEnvelope[]> {
    return replayProject(this.database.client, projectId);
  }

  /** Replays the global (project-less) non-ephemeral events, in emission order. */
  async replayGlobal(): Promise<EventEnvelope[]> {
    return replayGlobalEvents(this.database.client);
  }

  /** The project ids that have events, derived from the log itself. */
  async projectIds(): Promise<string[]> {
    return listProjectIds(this.database.client);
  }
}