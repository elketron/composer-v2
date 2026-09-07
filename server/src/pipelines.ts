// The default coding pipeline (v1 M3, staged in Phase 10): every project
// seeds it exactly once — the boot seed checks both the pipeline's
// presence and its deletion tombstone, so a deleted default stays dead
// (and its id is reusable). The Review stage carries the shipped outcome
// rules (S36): the reviewer's verdict drives the transition, and a
// requested rework returns the card to Implementation.

import type { Bus } from './bus.js';
import type { State } from './fold.js';
import type { Pipeline } from './wire/models.js';

export const DEFAULT_PIPELINE_ID = 'PL-1';

export function defaultPipeline(projectId: string): Pipeline {
  return {
    id: DEFAULT_PIPELINE_ID,
    projectId,
    name: 'Standard coding card',
    revision: 1,
    stages: [
      { id: 'sg-1', label: 'New', kanbanVisible: true },
      { id: 'sg-2', label: 'Implementation', kanbanVisible: true },
      { id: 'sg-3', label: 'Validation', kanbanVisible: true, errorReturnToStageId: 'sg-2' },
      {
        id: 'sg-4',
        label: 'Review',
        kanbanVisible: true,
        outcomes: [{ outcome: 'approved' }, { outcome: 'changes_requested', toStageId: 'sg-2' }],
        requiresOutcome: true,
      },
      { id: 'sg-5', label: 'Approval', kanbanVisible: true, errorReturnToStageId: 'sg-2' },
      { id: 'sg-6', label: 'Done', kanbanVisible: true, terminal: true },
    ],
    steps: [
      {
        id: 'st-1',
        kind: 'agent',
        stageId: 'sg-2',
        agentKind: 'coder',
        instructions: 'Implement the card per its description.',
      },
      { id: 'st-2', kind: 'command', stageId: 'sg-3', command: 'npm run build', description: 'Build' },
      { id: 'st-3', kind: 'command', stageId: 'sg-3', command: 'npm test', description: 'Run tests' },
      {
        id: 'st-4',
        kind: 'agent',
        stageId: 'sg-4',
        agentKind: 'reviewer',
        instructions: 'Review the implemented card.',
      },
      { id: 'st-5', kind: 'human', stageId: 'sg-5', description: 'Approval' },
    ],
    updatedAt: '',
  };
}

/** Seeds the default pipeline for one project unless present or tombstoned. */
export async function seedDefaultPipeline(bus: Bus, projectId: string): Promise<void> {
  const project = bus.state.byProject.get(projectId);
  if (project === undefined) return;
  if (project.pipelines.has(DEFAULT_PIPELINE_ID)) return;
  if (project.deletedPipelines.has(DEFAULT_PIPELINE_ID)) return;
  await bus.publish(projectId, 'pipelineSaved', { pipeline: defaultPipeline(projectId) });
}

/** Seeds every registered project (boot). */
export async function seedDefaultPipelines(state: State, bus: Bus): Promise<void> {
  for (const projectId of state.projects.keys()) {
    await seedDefaultPipeline(bus, projectId);
  }
}

/** A restart ends active runs `cancelled` (boot). */
export async function cancelInterruptedRuns(bus: Bus): Promise<number> {
  let cancelled = 0;
  for (const [projectId, project] of bus.state.byProject) {
    for (const run of project.runs.values()) {
      if (run.status !== 'running' && run.status !== 'waiting') continue;
      await bus.publish(projectId, 'pipelineRunEnded', {
        runId: run.id,
        cardId: run.cardId,
        pipelineId: run.pipelineId,
        revision: run.revision,
        status: 'cancelled',
      });
      cancelled += 1;
    }
  }
  return cancelled;
}
