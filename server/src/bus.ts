// The single write path (v1 architecture.md): publish holds one async lock
// across append (persist) → apply (the fold) → fan-out (subscribers), so
// event order always matches the log and a failed append changes nothing.
// Ephemeral events persist for the live stream but skip replay.

import { randomUUID } from 'node:crypto';
import type { EventEnvelope, EventFrame } from './wire/envelope.js';
import { makeFrame, nowIso } from './wire/envelope.js';
import type { EventName } from './wire/events.js';
import { EPHEMERAL } from './wire/events.js';
import type { State } from './fold/index.js';
import { apply as applyFold, newState } from './fold/index.js';
import type { EventStore } from './store/index.js';

export type Subscriber = (frame: EventFrame) => void;

export class Bus {
  readonly state: State = newState();
  private store: EventStore;
  private subscribers = new Set<Subscriber>();
  private writeLock: Promise<unknown> = Promise.resolve();

  constructor(store: EventStore) {
    this.store = store;
  }

  /** Rehydrates every project's log (and the global events) into the fold. */
  async rehydrate(): Promise<number> {
    let count = 0;
    for (const envelope of await this.store.replayGlobal()) {
      this.apply(envelope);
      count += 1;
    }
    for (const projectId of await this.store.projectIds()) {
      for (const envelope of await this.store.replay(projectId)) {
        this.apply(envelope);
        count += 1;
      }
    }
    return count;
  }

  /**
   * Publishes one event: persist, fold, fan out — under the write lock, in
   * that order. Resolves after the event is applied to state.
   */
  async publish(
    projectId: string | undefined,
    name: EventName,
    body: unknown,
    options?: { ephemeral?: boolean; id?: string },
  ): Promise<EventEnvelope> {
    const envelope: EventEnvelope = {
      id: options?.id ?? randomUUID(),
      ...(projectId !== undefined ? { projectId } : {}),
      occurredAt: nowIso(),
      name,
      body,
    };
    const ephemeral = options?.ephemeral ?? EPHEMERAL.has(name);
    const run = this.writeLock.then(async () => {
      await this.store.append(envelope, ephemeral);
      this.apply(envelope);
      for (const subscriber of this.subscribers) {
        subscriber(makeFrame(envelope));
      }
    });
    this.writeLock = run.catch(() => undefined);
    await run;
    return envelope;
  }

  apply(envelope: EventEnvelope): void {
    // The fold is imported lazily-free: apply is a plain function over state.
    applyFold(this.state, envelope);
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }
}
