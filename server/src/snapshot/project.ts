// One project's snapshot appender: the per-project reconstruction in the
// fold's expected order (automations, planning sessions, agent sessions,
// pipeline revisions, runs, cards, then dependency state). The project
// creation event and the blocked-card pass ride the aggregate's link rules
// (Board).

import { Board } from '../domain/board.js';
import type { Project } from '../domain/project.js';
import type { ProjectState } from '../fold/index.js';
import type { FrameEmitter } from './emit.js';

/** Terminal runs replayed per card (older attempts stay in the log). */
const TERMINAL_RUNS_PER_CARD = 20;

export function appendProject(emit: FrameEmitter, project: Project, projectState: ProjectState): void {
  emit(project.id, 'projectCreated', { project: project.toWire() });
  const board = Board.of(projectState);

  const automations = [...projectState.automation.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [pipelineId, steps] of automations) {
    for (const [stepId, on] of [...steps.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      emit(project.id, 'automationToggled', { pipelineId, stepId, on });
    }
  }

  // Planning sessions replay their current record (the creation event
  // carries the folded session: document and messages included) and then
  // each message, so partial folds reconcile idempotently (v1 order).
  const sessions = [...projectState.planningSessions.values()].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  for (const session of sessions) {
    emit(project.id, 'planningSessionCreated', { session: structuredClone(session) });
    for (const message of session.messages) {
      const eventType = message.role === 'user' ? 'userMessageReceived' : 'agentMessageComplete';
      emit(project.id, eventType, { sessionId: session.id, message: structuredClone(message) });
    }
  }

  // Agent sessions replay as start → transcript → end (v1 order).
  const agentSessions = [...projectState.agentSessions.values()].sort(
    (a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id),
  );
  for (const session of agentSessions) {
    emit(
      project.id,
      'agentSessionStarted',
      {
        cardId: session.cardId,
        sessionId: session.id,
        agentKind: session.agentKind ?? 'coder',
        startedAt: session.startedAt,
      },
    );
    for (const entry of session.transcript) {
      if (entry.kind === 'message') {
        emit(project.id, 'agentMessageComplete', { sessionId: session.id, message: structuredClone(entry.message) });
      } else if (entry.kind === 'toolCall') {
        emit(project.id, 'agentToolCall', {
          sessionId: session.id,
          toolCallId: entry.toolCallId,
          toolName: entry.toolName,
          args: entry.args,
        });
      } else {
        emit(project.id, 'agentToolResult', {
          sessionId: session.id,
          toolCallId: entry.toolCallId,
          content: entry.content,
          isError: entry.isError,
        });
      }
    }
    if (session.status !== 'running') {
      emit(
        project.id,
        'agentSessionEnded',
        {
          cardId: session.cardId,
          sessionId: session.id,
          status: session.status,
          ...(session.error !== undefined ? { error: session.error } : {}),
          endedAt: session.endedAt ?? session.startedAt,
        },
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
    emit(project.id, 'pipelineSaved', { pipeline: pipeline.toWire() });
  }

  // Run records replay as compact started/ended pairs at their original
  // timestamps (active runs additionally replay their current step, so the
  // fold lands on the same run status and card position).
  const runs = [...projectState.runs.values()].sort(
    (a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id),
  );
  const terminalCountByCard = new Map<string, number>();
  for (const run of runs) {
    if (run.isActive) continue;
    const seen = terminalCountByCard.get(run.cardId) ?? 0;
    terminalCountByCard.set(run.cardId, seen + 1);
    if (seen >= TERMINAL_RUNS_PER_CARD) continue;
    emit(
      project.id,
      'pipelineRunStarted',
      { runId: run.id, cardId: run.cardId, pipelineId: run.pipelineId, revision: run.revision },
      run.startedAt,
    );
    emit(
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
      run.endedAt ?? run.startedAt,
    );
  }
  for (const run of runs) {
    if (!run.isActive) continue;
    emit(
      project.id,
      'pipelineRunStarted',
      { runId: run.id, cardId: run.cardId, pipelineId: run.pipelineId, revision: run.revision },
      run.startedAt,
    );
    if (run.stepId !== undefined && run.stepKind !== undefined) {
      emit(
        project.id,
        'pipelineStepStarted',
        {
          runId: run.id,
          cardId: run.cardId,
          pipelineId: run.pipelineId,
          stepId: run.stepId,
          kind: run.stepKind,
        },
      );
    }
  }

  for (const card of [...projectState.cards.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )) {
    emit(project.id, 'cardCreated', { card: card.toWire() });
  }
  // Blocked cards replay their dependency state (order-insensitive fold).
  for (const card of projectState.cards.values()) {
    if (board.isBlocked(card)) {
      emit(project.id, 'dependencyStateChanged', {
        cardId: card.id,
        blocked: true,
        blockedBy: [...card.blockedBy],
      });
    }
  }
}