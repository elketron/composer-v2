// The snapshot's shared frame factory: one nonce-scoped, index-ordered
// emitter the per-domain appenders push synthetic frames through. A reused
// event id would make reconnect-deduplicating clients drop a state
// transition, so the nonce keeps re-deliveries distinct (v1 rule).

import type { EventFrame } from '../wire/envelope.js';
import { nowIso } from '../wire/envelope.js';
import type { EventName } from '../wire/events.js';

/** An appender's sink: one synthetic frame, timestamps default to now. */
export type FrameEmitter = (
  projectId: string | undefined,
  name: EventName,
  body: unknown,
  occurredAt?: string,
) => void;

function frame(
  projectId: string | undefined,
  name: EventName,
  body: unknown,
  nonce: string,
  index: number,
  occurredAt = nowIso(),
): EventFrame {
  return {
    id: `snapshot-${nonce}-${index}`,
    ...(projectId !== undefined ? { projectId } : {}),
    occurredAt,
    eventType: name,
    body,
  };
}

/** A closure over one shared index counter (one per snapshot). */
export function makeEmitter(events: EventFrame[], nonce: string): FrameEmitter {
  let index = 0;
  return (projectId, name, body, occurredAt = nowIso()) => {
    events.push(frame(projectId, name, body, nonce, index, occurredAt));
    index += 1;
  };
}