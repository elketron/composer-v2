import type { DomainEventJson } from './wire';

/**
 * The event-id dedupe all folds share (FNT-006): a replay (a reconnect's
 * snapshot overlapping the live stream, or a duplicated delivery) folds
 * once — the first frame of each id passes, later ones drop. One
 * instance per service; the cap evicts the oldest ids so a long session
 * can't grow the map unbounded.
 */
export class EventDeduper {
  private readonly seen = new Map<string, true>();

  constructor(private readonly cap = 4096) {}

  /** True when the event is new (no id always passes). */
  first(event: Pick<DomainEventJson, 'id'>): boolean {
    if (!event.id) return true;
    if (this.seen.has(event.id)) return false;
    this.seen.set(event.id, true);
    if (this.seen.size > this.cap) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }
}
