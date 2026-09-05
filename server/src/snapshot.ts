// The SSE snapshot: current state replayed as synthetic events, in the
// fold's expected order (v1 rule — folds are idempotent, so a resubscribe
// with fresh ids is safe).

import type { EventFrame } from './wire/envelope.js';
import { nowIso } from './wire/envelope.js';
import type { EventName } from './wire/events.js';
import type { CardState, State } from './fold.js';

function frame(
  projectId: string | undefined,
  name: EventName,
  body: unknown,
  index: number,
): EventFrame {
  return {
    id: `snapshot-${index}`,
    ...(projectId !== undefined ? { projectId } : {}),
    occurredAt: nowIso(),
    eventType: name,
    body,
  };
}

export function snapshotEvents(state: State, projectId?: string): EventFrame[] {
  const events: EventFrame[] = [];
  let index = 0;
  const projects = [...state.projects.values()]
    .filter((project) => projectId === undefined || project.id === projectId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  for (const project of projects) {
    events.push(frame(project.id, 'projectCreated', { project }, index++));
    const projectState = state.byProject.get(project.id);
    if (!projectState) continue;

    const automation = [...projectState.automation.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    for (const [lane, on] of automation) {
      events.push(frame(project.id, 'automationToggled', { lane, on }, index++));
    }

    // Planning sessions replay their current record (the creation event
    // carries the folded session: document and messages included) and then
    // each message, so partial folds reconcile idempotently (v1 order).
    const sessions = [...projectState.planningSessions.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
    for (const session of sessions) {
      events.push(frame(project.id, 'planningSessionCreated', { session: structuredClone(session) }, index++));
      for (const message of session.messages) {
        const eventType = message.role === 'user' ? 'userMessageReceived' : 'agentMessageComplete';
        events.push(
          frame(
            project.id,
            eventType,
            { sessionId: session.id, message: structuredClone(message) },
            index++,
          ),
        );
      }
    }

    for (const card of [...projectState.cards.values()].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )) {
      events.push(frame(project.id, 'cardCreated', { card: { ...card } }, index++));
    }
    // Blocked cards replay their dependency state (order-insensitive fold).
    for (const card of projectState.cards.values()) {
      if (isBlocked(projectState.cards, card)) {
        events.push(
          frame(
            project.id,
            'dependencyStateChanged',
            { cardId: card.id, blocked: true, blockedBy: [...card.blockedBy] },
            index++,
          ),
        );
      }
    }
  }
  return events;
}

function isBlocked(cards: Map<string, CardState>, card: CardState): boolean {
  if (card.blockedBy.length === 0) return false;
  return card.blockedBy.some((blocker) => {
    const other = cards.get(blocker);
    return other !== undefined && other.stage !== 'done';
  });
}
