// The card/thread transition runner: the object answers with its events
// (or a typed rejection), and the events publish in order under the write
// lock.

import type { Bus } from '../bus.js';
import type { CommandOutcome } from '../wire/commands.js';
import type { PendingEvent } from '../domain/rejection.js';
import { ok, toRejection } from './helpers.js';

export async function transition(
  bus: Bus,
  projectId: string | undefined,
  answer: () => PendingEvent[],
): Promise<CommandOutcome> {
  let events: PendingEvent[];
  try {
    events = answer();
  } catch (error) {
    return toRejection(error);
  }
  for (const pending of events) {
    await bus.publish(projectId, pending.name, pending.body);
  }
  return ok();
}
