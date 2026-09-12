// The lane automation seam (Phase 10): the board's per-lane toggles fold
// into state; the runner reads them to run cards without a human nudge —
// any card entering an automated lane runs. Human gates always park:
// automation starts runs, it never answers for a person.

import type { Bus } from '../bus.js';

/**
 * Consecutive automated runs one card gets without a completed run in
 * between — a rework loop that never converges must not run forever.
 */
export const AUTO_RUN_CAP = 10;

/** Whether the pipeline lane's automation toggle is on (the fold's record). */
export function laneAutomated(
  bus: Bus,
  projectId: string,
  pipelineId: string,
  laneId: string,
): boolean {
  return (
    bus.state.byProject.get(projectId)?.automation.get(pipelineId)?.get(laneId) === true
  );
}

/**
 * Whether the lane parks cards (it holds a backlog step): automation never
 * runs a card into a backlog lane — the backlog holds work until a human
 * promotes it.
 */
export function laneIsBacklog(
  bus: Bus,
  projectId: string,
  pipelineId: string,
  laneId: string,
): boolean {
  const pipeline = bus.state.byProject.get(projectId)?.pipelines.get(pipelineId);
  return pipeline?.steps.some((step) => step.laneId === laneId && step.kind === 'backlog') === true;
}