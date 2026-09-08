// The current-state projection: a fold of every canonical event, per
// project keyed, idempotent (v1 architecture.md §Projection). Re-applying
// events yields the same state; the SSE snapshot is built from it.
//
// The fold builds the domain objects (server/src/domain): cards, pipelines,
// runs, and projects are immutable instances replaced via `with()` as their
// events land — no shared mutable records.
//
// The event handlers are a map (per domain file), not a switch: each
// catalog event has at most one fold step, and unknown names are ignored so
// the fold is total over the catalog.

import type { EventEnvelope } from '../wire/envelope.js';
import type { EventName } from '../wire/events.js';
import { cardHandlers } from './cards.js';
import { pipelineHandlers } from './pipelines.js';
import { planningHandlers } from './planning.js';
import { projectHandlers } from './projects.js';
import { proposalHandlers } from './proposals.js';
import { sessionHandlers } from './sessions.js';
import { threadHandlers } from './threads.js';
import { type State, newState } from './state.js';

export {
  type AgentSessionState,
  emptyProjectState,
  newState,
  type ProjectState,
  type State,
  type TranscriptEntryState,
} from './state.js';

/** Every fold step, keyed by event name — one handler per catalog event. */
const handlers = new Map<EventName, (state: State, envelope: EventEnvelope, projectId: string) => void>(
  Object.entries({
    ...projectHandlers,
    ...cardHandlers,
    ...planningHandlers,
    ...pipelineHandlers,
    ...sessionHandlers,
    ...threadHandlers,
    ...proposalHandlers,
  }) as [EventName, (state: State, envelope: EventEnvelope, projectId: string) => void][],
);

/**
 * Folds one canonical event into state. Idempotent: re-applying an event
 * changes nothing (S0 folds the project domain; cards, planning, agent
 * sessions, and pipelines join in their slices).
 */
export function apply(state: State, envelope: EventEnvelope): void {
  const handler = handlers.get(envelope.name as EventName);
  if (handler !== undefined) {
    handler(state, envelope, envelope.projectId ?? '');
  }
}
