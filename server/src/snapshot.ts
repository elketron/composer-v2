// The SSE snapshot: current state replayed as synthetic events, in the
// fold's expected order (v1 rule — folds are idempotent, so a resubscribe
// with fresh ids is safe).

import { randomUUID } from 'node:crypto';
import type { EventFrame } from './wire/envelope.js';
import { nowIso } from './wire/envelope.js';
import type { EventName } from './wire/events.js';
import type { CardState, State } from './fold.js';

function frame(
  projectId: string | undefined,
  name: EventName,
  body: unknown,
  nonce: string,
  index: number,
  occurredAt = nowIso(),
): EventFrame {
  return {
    // The per-snapshot nonce keeps reconnects' re-deliveries distinct for
    // clients that dedupe by event id — a reused id would make them drop
    // a state transition (e.g. the completion that clears a send-lock).
    id: `snapshot-${nonce}-${index}`,
    ...(projectId !== undefined ? { projectId } : {}),
    occurredAt,
    eventType: name,
    body,
  };
}

export function snapshotEvents(state: State, projectId?: string): EventFrame[] {
  const events: EventFrame[] = [];
  const nonce = randomUUID().slice(0, 8);
  let index = 0;

  // Global assistant threads first (Phase 6): the creation event carries the
  // folded thread (scope, status, messages), then each message re-folds
  // idempotently — the planning session's snapshot rule.
  if (projectId === undefined) {
    const threads = [...state.assistantThreads.values()].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
    for (const thread of threads) {
      events.push(frame(undefined, 'assistantThreadCreated', { thread: structuredClone(thread) }, nonce, index++));
      for (const message of thread.messages) {
        const eventType = message.role === 'user' ? 'assistantUserMessage' : 'assistantMessageComplete';
        events.push(
          frame(
            undefined,
            eventType,
            { threadId: thread.id, message: structuredClone(message) },
            nonce,
            index++,
          ),
        );
      }
      // The message replays derive running/idle; a stopped or failed thread
      // re-marks itself so its terminal status survives the snapshot.
      if (thread.status === 'stopped' || thread.status === 'failed') {
        events.push(
          frame(undefined, 'assistantThreadStatusChanged', { threadId: thread.id, status: thread.status }, nonce, index++),
        );
      }
    }
  }

  // Work proposals (Phase 8): the creation event carries the folded record
  // (status, possibly edited items, batch outcomes).
  for (const proposal of [...state.proposals.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )) {
    events.push(frame(undefined, 'proposalDrafted', { proposal: structuredClone(proposal) }, nonce, index++));
  }

  const projects = [...state.projects.values()]
    .filter((project) => projectId === undefined || project.id === projectId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  for (const project of projects) {
    events.push(frame(project.id, 'projectCreated', { project }, nonce, index++));
    const projectState = state.byProject.get(project.id);
    if (!projectState) continue;

    const automation = [...projectState.automation.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    for (const [lane, on] of automation) {
      events.push(frame(project.id, 'automationToggled', { lane, on }, nonce, index++));
    }

    // Planning sessions replay their current record (the creation event
    // carries the folded session: document and messages included) and then
    // each message, so partial folds reconcile idempotently (v1 order).
    const sessions = [...projectState.planningSessions.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
    for (const session of sessions) {
      events.push(frame(project.id, 'planningSessionCreated', { session: structuredClone(session) }, nonce, index++));
      for (const message of session.messages) {
        const eventType = message.role === 'user' ? 'userMessageReceived' : 'agentMessageComplete';
        events.push(
          frame(
            project.id,
            eventType,
            { sessionId: session.id, message: structuredClone(message) },
            nonce,
            index++,
          ),
        );
      }
    }

    // Agent sessions replay as start → transcript → end (v1 order).
    const agentSessions = [...projectState.agentSessions.values()].sort(
      (a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id),
    );
    for (const session of agentSessions) {
      events.push(
        frame(
          project.id,
          'agentSessionStarted',
          { cardId: session.cardId, sessionId: session.id, agentKind: 'coder', startedAt: session.startedAt },
          nonce,
          index++,
        ),
      );
      for (const entry of session.transcript) {
        if (entry.kind === 'message') {
          events.push(
            frame(
              project.id,
              'agentMessageComplete',
              { sessionId: session.id, message: structuredClone(entry.message) },
              nonce,
              index++,
            ),
          );
        } else if (entry.kind === 'toolCall') {
          events.push(
            frame(
              project.id,
              'agentToolCall',
              { sessionId: session.id, toolCallId: entry.toolCallId, toolName: entry.toolName, args: entry.args },
              nonce,
              index++,
            ),
          );
        } else {
          events.push(
            frame(
              project.id,
              'agentToolResult',
              { sessionId: session.id, toolCallId: entry.toolCallId, content: entry.content, isError: entry.isError },
              nonce,
              index++,
            ),
          );
        }
      }
      if (session.status !== 'running') {
        events.push(
          frame(
            project.id,
            'agentSessionEnded',
            {
              cardId: session.cardId,
              sessionId: session.id,
              status: session.status,
              ...(session.error !== undefined ? { error: session.error } : {}),
              endedAt: session.endedAt ?? session.startedAt,
            },
            nonce,
            index++,
          ),
        );
      }
    }

    const pipelines = [...projectState.pipelines.values()].sort(
      (a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id),
    );
    for (const pipeline of pipelines) {
      events.push(frame(project.id, 'pipelineSaved', { pipeline: structuredClone(pipeline) }, nonce, index++));
    }

    // Terminal latest-run outcomes are durable dashboard state. Recreate the
    // run lifecycle at its original timestamps so the projection round-trips.
    const latestRuns = [...projectState.latestRuns.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [cardId, run] of latestRuns) {
      if (run.status === 'running' || run.status === 'waiting') continue;
      events.push(
        frame(
          project.id,
          'pipelineRunStarted',
          { cardId, pipelineId: run.pipelineId },
          nonce,
          index++,
          run.startedAt,
        ),
      );
      events.push(
        frame(
          project.id,
          'pipelineRunEnded',
          {
            cardId,
            pipelineId: run.pipelineId,
            status: run.status,
            ...(run.error !== undefined ? { error: run.error } : {}),
          },
          nonce,
          index++,
          run.endedAt ?? run.startedAt,
        ),
      );
    }

    // Active pipeline runs replay as runStarted (+ the current step, so
    // the fold lands on the same run status).
    const runs = [...projectState.pipelineRuns.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [cardId, run] of runs) {
      const startedAt = projectState.latestRuns.get(cardId)?.startedAt;
      events.push(
        frame(
          project.id,
          'pipelineRunStarted',
          { cardId, pipelineId: run.pipelineId },
          nonce,
          index++,
          startedAt,
        ),
      );
      if (run.stepId !== undefined && run.stepKind !== undefined) {
        events.push(
          frame(
            project.id,
            'pipelineStepStarted',
            { cardId, pipelineId: run.pipelineId, stepId: run.stepId, kind: run.stepKind },
            nonce,
            index++,
          ),
        );
      }
    }

    for (const card of [...projectState.cards.values()].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )) {
      events.push(frame(project.id, 'cardCreated', { card: { ...card } }, nonce, index++));
    }
    // Blocked cards replay their dependency state (order-insensitive fold).
    for (const card of projectState.cards.values()) {
      if (isBlocked(projectState.cards, card)) {
        events.push(
          frame(
            project.id,
            'dependencyStateChanged',
            { cardId: card.id, blocked: true, blockedBy: [...card.blockedBy] },
            nonce,
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
