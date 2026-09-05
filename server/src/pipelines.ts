// The default coding pipeline (v1 M3): every project seeds
// `coder → build → test → approval` exactly once — the boot seed checks
// both the pipeline's presence and its deletion tombstone, so a deleted
// default stays dead (and its id is reusable).

import type { Bus } from './bus.js';
import type { State } from './fold.js';
import type { Pipeline } from './wire/models.js';

export const DEFAULT_PIPELINE_ID = 'PL-1';

export function defaultPipeline(projectId: string): Pipeline {
  return {
    id: DEFAULT_PIPELINE_ID,
    projectId,
    name: 'Standard coding card',
    steps: [
      {
        id: 'st-1',
        kind: 'agent',
        agentKind: 'coder',
        instructions: 'Implement the card per its description.',
      },
      { id: 'st-2', kind: 'command', command: 'npm run build', description: 'Build', retries: 1 },
      { id: 'st-3', kind: 'command', command: 'npm test', description: 'Run tests', retries: 1 },
      { id: 'st-4', kind: 'human', description: 'Approval' },
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

/** D5: a restart ends non-terminal runs `cancelled` (boot). */
export async function cancelInterruptedRuns(bus: Bus): Promise<number> {
  let cancelled = 0;
  for (const [projectId, project] of bus.state.byProject) {
    for (const [cardId, run] of project.pipelineRuns) {
      await bus.publish(projectId, 'pipelineRunEnded', {
        cardId,
        pipelineId: run.pipelineId,
        status: 'cancelled',
      });
      cancelled += 1;
    }
  }
  return cancelled;
}
