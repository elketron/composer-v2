// Translates runner-relevant stream frames into live task coordination.
// Lane automation rides the same stream: a card entering an automated
// lane (creation, assignment, a drag, an outcome route) kicks a run, and
// a completed run re-arms that card's auto-run budget.

import type { Bus } from '../bus.js';
import type { EventFrame } from '../wire/envelope.js';
import type { RunTask } from './types.js';

/** The lane-automation hooks the runner supplies (state reads + the kick). */
export interface AutomationHooks {
  automated(projectId: string, pipelineId: string, laneId: string): boolean;
  /** Whether the lane parks cards (a backlog lane never auto-runs). */
  parked(projectId: string, pipelineId: string, laneId: string): boolean;
  /** Kicks one validated run for the card (best-effort, deferred a tick). */
  kick(projectId: string, cardId: string): void;
  /** Re-arms a card's auto-run budget (its run completed). */
  reset(projectId: string, cardId: string): void;
}

export async function handleFrame(
  bus: Bus,
  tasks: Map<string, RunTask>,
  startRun: (
    projectId: string,
    runId: string,
    cardId: string,
    pipelineId: string,
    revision: number | undefined,
  ) => Promise<void>,
  automation: AutomationHooks,
  frame: EventFrame,
): Promise<void> {
  switch (frame.eventType) {
    case 'pipelineRunStarted': {
      const body = frame.body as {
        runId?: string;
        cardId?: string;
        pipelineId?: string;
        revision?: number;
      };
      if (
        frame.projectId === undefined ||
        body.runId === undefined ||
        body.cardId === undefined ||
        body.pipelineId === undefined
      ) {
        return;
      }
      await startRun(frame.projectId, body.runId, body.cardId, body.pipelineId, body.revision);
      return;
    }
    case 'pipelineGateResponded': {
      const body = frame.body as { runId?: string; cardId?: string; approved?: boolean; comment?: string };
      const runId = body.runId ?? (body.cardId !== undefined
        ? bus.state.byProject.get(frame.projectId ?? '')?.activeRuns.get(body.cardId)
        : undefined);
      if (runId === undefined) return;
      tasks.get(runId)?.resolveGate?.({
        approved: body.approved ?? false,
        ...(body.comment !== undefined ? { comment: body.comment } : {}),
      });
      return;
    }
    case 'pipelineRunEnded': {
      const body = frame.body as { runId?: string; cardId?: string; status?: string };
      if (frame.projectId !== undefined && body.cardId !== undefined && body.status === 'completed') {
        // The card reached its terminal lane: the auto-run budget re-arms.
        automation.reset(frame.projectId, body.cardId);
      }
      if (body.status !== 'cancelled' || body.runId === undefined) return;
      const task = tasks.get(body.runId);
      if (task === undefined) return;
      // The cancelled event is already on the stream. Keep the task mapped
      // until drive's finally so drain() still observes its unwind.
      task.stopped = true;
      task.abort.abort();
      task.child?.cancel();
      task.resolveGate?.('cancelled');
      return;
    }
    case 'pipelineOutcomeReported': {
      const body = frame.body as { runId?: string; stepId?: string; outcome?: string; note?: string };
      if (body.runId === undefined || body.stepId === undefined || body.outcome === undefined) return;
      const task = tasks.get(body.runId);
      if (task === undefined) return;
      task.outcome = {
        stepId: body.stepId,
        outcome: body.outcome,
        ...(body.note !== undefined ? { note: body.note } : {}),
      };
      return;
    }
    case 'cardCreated': {
      const body = frame.body as { card?: { id?: string; pipelineId?: string; laneId?: string } };
      const card = body.card;
      if (
        frame.projectId === undefined ||
        card?.id === undefined ||
        card.pipelineId === undefined ||
        card.laneId === undefined
      ) {
        return;
      }
      maybeAutoRun(automation, frame.projectId, card.pipelineId, card.laneId, card.id);
      return;
    }
    case 'cardsCommitted': {
      const body = frame.body as { cards?: Array<{ id?: string; pipelineId?: string; laneId?: string }> };
      if (frame.projectId === undefined) return;
      for (const card of body.cards ?? []) {
        if (card.id === undefined || card.pipelineId === undefined || card.laneId === undefined) continue;
        maybeAutoRun(automation, frame.projectId, card.pipelineId, card.laneId, card.id);
      }
      return;
    }
    case 'cardPipelineAssigned': {
      const body = frame.body as { cardId?: string; pipelineId?: string; laneId?: string };
      if (
        frame.projectId === undefined ||
        body.cardId === undefined ||
        body.pipelineId === undefined ||
        body.laneId === undefined
      ) {
        return;
      }
      maybeAutoRun(automation, frame.projectId, body.pipelineId, body.laneId, body.cardId);
      return;
    }
    case 'cardLaneMoved': {
      const body = frame.body as { cardId?: string; pipelineId?: string; toLaneId?: string };
      if (
        frame.projectId === undefined ||
        body.cardId === undefined ||
        body.pipelineId === undefined ||
        body.toLaneId === undefined
      ) {
        return;
      }
      maybeAutoRun(automation, frame.projectId, body.pipelineId, body.toLaneId, body.cardId);
      return;
    }
    default:
      return;
  }
}

/** Runs the card when its destination lane's automation is on (backlog lanes park instead). */
function maybeAutoRun(
  automation: AutomationHooks,
  projectId: string,
  pipelineId: string,
  laneId: string,
  cardId: string,
): void {
  if (automation.parked(projectId, pipelineId, laneId)) return;
  if (!automation.automated(projectId, pipelineId, laneId)) return;
  automation.kick(projectId, cardId);
}