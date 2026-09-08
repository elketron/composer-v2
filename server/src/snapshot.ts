// The SSE snapshot: current state replayed as synthetic events, in the
// fold's expected order (v1 rule — folds are idempotent, so a resubscribe
// with fresh ids is safe).

import { randomUUID } from 'node:crypto';
import type { EventFrame } from './wire/envelope.js';
import { nowIso } from './wire/envelope.js';
import type { EventName } from './wire/events.js';
import type { ProjectState, State } from './fold/index.js';
import { Board } from './domain/board.js';

/** Terminal runs replayed per card (older attempts stay in the log). */
const TERMINAL_RUNS_PER_CARD = 20;

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
    events.push(frame(project.id, 'projectCreated', { project: project.toWire() }, nonce, index++));
    const projectState = state.byProject.get(project.id);
    if (!projectState) continue;
    const board = Board.of(projectState);

    const automations = [...projectState.automation.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [pipelineId, stages] of automations) {
      for (const [stageId, on] of [...stages.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        events.push(frame(project.id, 'automationToggled', { pipelineId, stageId, on }, nonce, index++));
      }
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
          {
            cardId: session.cardId,
            sessionId: session.id,
            agentKind: session.agentKind ?? 'coder',
            startedAt: session.startedAt,
          },
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

    // Every saved pipeline revision replays (runs pin theirs; the fold's
    // highest-revision rule picks up the current definition).
    const revisions = [...projectState.pipelineRevisions.values()]
      .flatMap((byRevision) => [...byRevision.values()])
      .sort(
        (a, b) =>
          a.updatedAt.localeCompare(b.updatedAt) ||
          a.id.localeCompare(b.id) ||
          a.revision - b.revision,
      );
    for (const pipeline of revisions) {
      events.push(frame(project.id, 'pipelineSaved', { pipeline: pipeline.toWire() }, nonce, index++));
    }

    // Run records replay as compact started/ended pairs at their original
    // timestamps (active runs additionally replay their current step, so
    // the fold lands on the same run status and card position).
    const runs = [...projectState.runs.values()].sort(
      (a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id),
    );
    const terminalCountByCard = new Map<string, number>();
    for (const run of runs) {
      if (run.isActive) continue;
      const seen = terminalCountByCard.get(run.cardId) ?? 0;
      terminalCountByCard.set(run.cardId, seen + 1);
      if (seen >= TERMINAL_RUNS_PER_CARD) continue;
      events.push(
        frame(
          project.id,
          'pipelineRunStarted',
          { runId: run.id, cardId: run.cardId, pipelineId: run.pipelineId, revision: run.revision },
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
            runId: run.id,
            cardId: run.cardId,
            pipelineId: run.pipelineId,
            revision: run.revision,
            status: run.status,
            ...(run.error !== undefined ? { error: run.error } : {}),
          },
          nonce,
          index++,
          run.endedAt ?? run.startedAt,
        ),
      );
    }
    for (const run of runs) {
      if (!run.isActive) continue;
      events.push(
        frame(
          project.id,
          'pipelineRunStarted',
          { runId: run.id, cardId: run.cardId, pipelineId: run.pipelineId, revision: run.revision },
          nonce,
          index++,
          run.startedAt,
        ),
      );
      if (run.stepId !== undefined && run.stepKind !== undefined && run.stageId !== undefined) {
        events.push(
          frame(
            project.id,
            'pipelineStepStarted',
            {
              runId: run.id,
              cardId: run.cardId,
              pipelineId: run.pipelineId,
              stepId: run.stepId,
              kind: run.stepKind,
              stageId: run.stageId,
            },
            nonce,
            index++,
          ),
        );
      }
    }

    for (const card of [...projectState.cards.values()].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )) {
      events.push(frame(project.id, 'cardCreated', { card: card.toWire() }, nonce, index++));
    }
    // Blocked cards replay their dependency state (order-insensitive fold).
    for (const card of projectState.cards.values()) {
      if (board.isBlocked(card)) {
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
