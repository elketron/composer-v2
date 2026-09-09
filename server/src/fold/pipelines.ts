// The pipeline and run domains' fold steps: saved revisions (highest
// revision wins as current; every revision lands in the pinned history),
// deletion tombstones, and the run lifecycle — started, step started (the
// card follows the step's stage), step finished, gate answers, and ends.

import { Pipeline } from '../domain/pipeline.js';
import { Run } from '../domain/run.js';
import { projectStateOf, readBody, type FoldHandler, type ProjectState } from './state.js';

export const pipelineHandlers: Record<string, FoldHandler> = {
  pipelineSaved: (state, envelope, projectId) => {
    const body = readBody(envelope, 'pipelineSaved');
    const project = projectStateOf(state, projectId);
    const pipeline = Pipeline.fromWire(body.pipeline);
    // Revisions may fold in any order across reconnects; the highest wins
    // as current, and every revision lands in the pinned history.
    const current = project.pipelines.get(pipeline.id);
    if (current === undefined || pipeline.revision >= current.revision) {
      project.pipelines.set(pipeline.id, pipeline);
    }
    let revisions = project.pipelineRevisions.get(pipeline.id);
    if (!revisions) {
      revisions = new Map();
      project.pipelineRevisions.set(pipeline.id, revisions);
    }
    revisions.set(pipeline.revision, pipeline);
    project.deletedPipelines.delete(pipeline.id);
  },
  pipelineDeleted: (state, envelope, projectId) => {
    const body = readBody(envelope, 'pipelineDeleted');
    const project = projectStateOf(state, projectId);
    project.pipelines.delete(body.pipelineId);
    // The tombstone keeps the boot seed from resurrecting the default.
    // The pinned revisions stay: historical runs keep theirs.
    project.deletedPipelines.add(body.pipelineId);
  },
  pipelineRunStarted: (state, envelope, projectId) => {
    const body = readBody(envelope, 'pipelineRunStarted');
    const project = projectStateOf(state, projectId);
    project.runs.set(
      body.runId,
      new Run({
        id: body.runId,
        cardId: body.cardId,
        pipelineId: body.pipelineId,
        revision: body.revision,
        status: 'running',
        startedAt: envelope.occurredAt,
      }),
    );
    project.activeRuns.set(body.cardId, body.runId);
  },
  pipelineStepStarted: (state, envelope, projectId) => {
    const body = readBody(envelope, 'pipelineStepStarted');
    const project = projectStateOf(state, projectId);
    const run = runOf(project, body.runId, body.cardId);
    if (run) {
      project.runs.set(
        run.id,
        run.with({
          stepId: body.stepId,
          stepKind: body.kind,
          // Only a gate waits; an agent or command step runs.
          status: body.kind === 'human' ? 'waiting' : 'running',
        }),
      );
    }
    // The run owns step transitions: the card follows the executing step
    // (hidden steps project to the previous visible swimlane client-side).
    const card = project.cards.get(body.cardId);
    if (card) {
      project.cards.set(
        body.cardId,
        card.with({
          stepId: body.stepId,
          stepStates: { ...card.stepStates, [body.stepId]: 'running' },
          updatedAt: envelope.occurredAt,
        }),
      );
    }
  },
  pipelineStepFinished: (state, envelope, projectId) => {
    const body = readBody(envelope, 'pipelineStepFinished');
    const project = projectStateOf(state, projectId);
    const run = runOf(project, body.runId, body.cardId);
    if (run && run.stepId === body.stepId && body.error !== undefined) {
      project.runs.set(run.id, run.with({ error: body.error }));
    }
    const card = project.cards.get(body.cardId);
    if (card) {
      project.cards.set(
        body.cardId,
        card.with({
          stepStates: { ...card.stepStates, [body.stepId]: body.ok ? 'ok' : 'failed' },
          updatedAt: envelope.occurredAt,
        }),
      );
    }
  },
  pipelineRunEnded: (state, envelope, projectId) => {
    const body = readBody(envelope, 'pipelineRunEnded');
    const project = projectStateOf(state, projectId);
    const run = runOf(project, body.runId, body.cardId);
    if (run) {
      project.runs.set(
        run.id,
        run.with({
          status: body.status,
          endedAt: envelope.occurredAt,
          ...(body.error !== undefined ? { error: body.error } : {}),
          ...(body.outcome !== undefined ? { outcome: body.outcome } : {}),
          ...(body.feedback !== undefined ? { feedback: body.feedback } : {}),
          ...(body.routedToStepId !== undefined ? { routedToStepId: body.routedToStepId } : {}),
          stepId: undefined,
          stepKind: undefined,
        }),
      );
    }
    project.activeRuns.delete(body.cardId);
  },
  pipelineGateResponded: (state, envelope, projectId) => {
    const body = readBody(envelope, 'pipelineGateResponded');
    const project = projectStateOf(state, projectId);
    const run = runOf(project, body.runId, body.cardId);
    if (run && run.status === 'waiting') {
      project.runs.set(run.id, run.with({ status: 'running' }));
    }
  },
};

/** The run a step/gate/end event belongs to: by runId, or the card's active run. */
function runOf(project: ProjectState, runId: string | undefined, cardId: string): Run | undefined {
  if (runId !== undefined) return project.runs.get(runId);
  const active = project.activeRuns.get(cardId);
  return active !== undefined ? project.runs.get(active) : undefined;
}
