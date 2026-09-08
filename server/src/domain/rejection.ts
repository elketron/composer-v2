// A command's transition vocabulary. Domain objects answer a command by
// returning the canonical events to publish, or by throwing a typed
// rejection — the processor maps it onto the wire outcome unchanged.

import type { EventBodyMap, EventName } from '../wire/events.js';
import type { Rejection } from '../wire/commands.js';

/** A transition refused: the code and message the wire outcome carries. */
export class CommandRejection extends Error {
  constructor(readonly code: Rejection['code'], message: string) {
    super(message);
  }
}

/** One canonical event a transition produced, awaiting publication. */
export interface PendingEvent {
  name: EventName;
  body: unknown;
}

/** Types a transition's event against the catalog (the body must match). */
export function event<N extends EventName>(name: N, body: EventBodyMap[N]): PendingEvent {
  return { name, body };
}
