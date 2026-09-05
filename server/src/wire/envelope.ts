// The event envelope: what the store persists and what flows through the
// bus. An SSE frame is the envelope flattened for the wire (v1 http.rs
// SseFrame): the eventType moves up next to the id, the payload becomes the
// body.

import type { EventName } from './events.js';

export interface EventEnvelope {
  id: string;
  projectId?: string;
  /** RFC 3339 with microseconds (the v1 wire convention). */
  occurredAt: string;
  name: EventName;
  body: unknown;
}

export interface EventFrame {
  id: string;
  projectId?: string;
  occurredAt: string;
  eventType: EventName;
  body: unknown;
}

export function makeFrame(envelope: EventEnvelope): EventFrame {
  return {
    id: envelope.id,
    ...(envelope.projectId !== undefined ? { projectId: envelope.projectId } : {}),
    occurredAt: envelope.occurredAt,
    eventType: envelope.name,
    body: envelope.body,
  };
}

/** RFC 3339 now, with microseconds (the v1 timestamp convention). */
export function nowIso(): string {
  const d = new Date();
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  const micros = pad(d.getUTCMilliseconds() * 1000, 6);
  return (
    `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}` +
    `T${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}` +
    `.${micros}Z`
  );
}
