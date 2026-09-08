// Translates runner-relevant stream frames into live task coordination.

import type { Bus } from '../bus.js';
import type { EventFrame } from '../wire/envelope.js';
import type { RunTask } from './types.js';

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
      const body = frame.body as { runId?: string; status?: string };
      if (body.status !== 'cancelled' || body.runId === undefined) return;
      const task = tasks.get(body.runId);
      if (task === undefined) return;
      // The cancelled event is already on the stream. Keep the task mapped
      // until drive's finally so drain() still observes its unwind.
      task.stopped = true;
      task.abort.abort();
      task.child?.kill('SIGKILL');
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
    default:
      return;
  }
}
