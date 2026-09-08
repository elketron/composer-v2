// The planning domain's fold steps: session creation, the transcript's
// message upserts (planning sessions share the agent-message event types
// with card-bound agent sessions — the session id claims the event), the
// plan document, and the committed tickets' cards.

import { Card } from '../domain/card.js';
import { projectStateOf, readBody, type FoldHandler, type State } from './state.js';
import type { EventEnvelope } from '../wire/envelope.js';

export const planningHandlers: Record<string, FoldHandler> = {
  planningSessionCreated: (state, envelope, projectId) => {
    const body = readBody(envelope, 'planningSessionCreated');
    projectStateOf(state, projectId).planningSessions.set(
      body.session.id,
      structuredClone(body.session),
    );
  },
  userMessageReceived: messageFold,
  agentMessageComplete: messageFold,
  planDocumentUpdated: (state, envelope, projectId) => {
    const body = readBody(envelope, 'planDocumentUpdated');
    const session = projectStateOf(state, projectId).planningSessions.get(body.sessionId);
    if (session) session.planDocument = body.document;
  },
  planningSessionCompleted: (state, envelope, projectId) => {
    const body = readBody(envelope, 'planningSessionCompleted');
    const session = projectStateOf(state, projectId).planningSessions.get(body.sessionId);
    if (session) session.status = 'done';
  },
  cardsCommitted: (state, envelope, projectId) => {
    const body = readBody(envelope, 'cardsCommitted');
    const cards = projectStateOf(state, projectId).cards;
    for (const card of body.cards) {
      cards.set(card.id, Card.fromWire(card));
    }
  },
};

/**
 * A message lands on the agent session's transcript first (the coder's);
 * planning sessions share the event type (v1 rule). A message never
 * steals a slot the opposite role already holds: the latecomer lands past
 * every folded message instead (re-applying the event finds its own slot
 * free, so the fold stays idempotent).
 */
function messageFold(state: State, envelope: EventEnvelope, projectId: string): void {
  const body =
    envelope.name === 'agentMessageComplete'
      ? readBody(envelope, 'agentMessageComplete')
      : readBody(envelope, 'userMessageReceived');
  const project = projectStateOf(state, projectId);
  const agentSession = project.agentSessions.get(body.sessionId);
  if (agentSession !== undefined) {
    agentSession.transcript = agentSession.transcript
      .filter((entry) => !(entry.kind === 'message' && entry.message.index === body.message.index))
      .concat({ kind: 'message', message: structuredClone(body.message) });
    return;
  }
  const session = project.planningSessions.get(body.sessionId);
  if (!session) return;
  session.messages = session.messages
    .filter((message) => message.index !== body.message.index)
    .concat(structuredClone(body.message))
    .sort((a, b) => a.index - b.index);
}
