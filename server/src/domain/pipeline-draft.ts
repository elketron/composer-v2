// The pipeline draft validation and normalization (SRV-008): the save
// command's rules — name, stages, the forward path, the terminal stage, and
// the per-kind step fields — plus the stage-default normalization and the
// same-definition comparison. These are draft-level concerns, split from the
// `Pipeline` model (which keeps topology and serialization).

import type {
  Pipeline as PipelineJson,
  PipelineStage as PipelineStageJson,
  PipelineStep as PipelineStepJson,
} from '../wire/models.js';
import type { Pipeline } from './pipeline.js';
import { CommandRejection } from './rejection.js';

/** Ceiling on steps one pipeline may carry (v1 M3). */
export const MAX_PIPELINE_STEPS = 64;

/**
 * Validates a user-authored draft in full — name, stages, the forward
 * path, the terminal stage — and returns the normalized stages the save
 * publishes. Same order, codes, and messages the processor emitted when
 * the validation lived there.
 */
export function validateDraft(draft: PipelineJson): PipelineStageJson[] {
  const rejection = (message: string): CommandRejection => new CommandRejection('invalidCommand', message);
  if (draft.name.trim() === '') {
    throw rejection('Pipeline name is required');
  }
  if (draft.stages.length === 0) {
    throw rejection('A pipeline needs at least one stage');
  }
  if (draft.steps.length === 0) {
    throw rejection('A pipeline needs at least one step');
  }
  if (draft.steps.length > MAX_PIPELINE_STEPS) {
    throw rejection(`Pipeline has ${draft.steps.length} steps; the limit is ${MAX_PIPELINE_STEPS}`);
  }

  const stageOrder = new Map<string, number>();
  for (const [index, stage] of draft.stages.entries()) {
    const id = stage.id.trim();
    if (id === '') {
      throw rejection(`Stage ${index + 1} needs an id`);
    }
    if (stageOrder.has(id)) {
      throw rejection(`Stage id '${id}' appears twice`);
    }
    stageOrder.set(id, index);
  }
  const stages = normalizeStages(draft.stages);
  for (const [index, stage] of stages.entries()) {
    const label = `Stage ${index + 1}`;
    if (stage.label.trim() === '') {
      throw rejection(`${label} needs a label`);
    }
for (const outcome of stage.outcomes ?? []) {
        if (outcome.outcome.trim() === '') {
          throw rejection(`${label}: an outcome needs a name`);
        }
        if (outcome.toStageId !== undefined) {
          assertEarlierReturn(stageOrder, index, outcome.toStageId, `outcome '${outcome.outcome}'`, label, rejection);
        }
      }
      const outcomeNames = (stage.outcomes ?? []).map((rule) => rule.outcome.trim());
      if (new Set(outcomeNames).size !== outcomeNames.length) {
        throw rejection(`${label}: outcome names must be unique`);
      }
      if (stage.errorReturnToStageId !== undefined) {
        assertEarlierReturn(stageOrder, index, stage.errorReturnToStageId, 'the error condition', label, rejection);
      }
    }

  const seenSteps = new Set<string>();
  let lastOrder = -1;
  for (const [index, step] of draft.steps.entries()) {
    const label = `Step ${index + 1}`;
    const id = step.id.trim();
    if (id === '') {
      throw rejection(`${label} needs an id`);
    }
    if (seenSteps.has(id)) {
      throw rejection(`Step id '${id}' appears twice`);
    }
    seenSteps.add(id);
    const stageIndex = stageOrder.get(step.stageId);
    if (stageIndex === undefined) {
      throw rejection(`${label}: stage '${step.stageId}' is not a stage of this pipeline`);
    }
    if (stageIndex < lastOrder) {
      throw rejection(`${label}: the normal path must not move to an earlier stage`);
    }
    lastOrder = stageIndex;
    const message = missingStepField(step);
    if (message !== null) {
      throw rejection(`${label}: ${message}`);
    }
  }

  const terminals = stages.filter((stage) => stage.terminal === true);
  if (terminals.length !== 1) {
    throw rejection('A pipeline needs exactly one terminal (Done) stage');
  }
  if (stages[stages.length - 1]?.terminal !== true) {
    throw rejection('The terminal stage must be the last stage');
  }
  if (stages[0]?.kanbanVisible !== true) {
    throw rejection('The first stage must be Kanban-visible');
  }
  return stages;
}

/** A stage reference must name a known, strictly-earlier stage. */
function assertEarlierReturn(
  stageOrder: Map<string, number>,
  index: number,
  targetId: string,
  what: string,
  label: string,
  rejection: (message: string) => CommandRejection,
): void {
  const target = stageOrder.get(targetId);
  if (target === undefined) {
    throw rejection(`${label}: ${what} names an unknown stage`);
  }
  if (target >= index) {
    throw rejection(`${label}: ${what} may only return to an earlier stage`);
  }
}

/** Fills the stage defaults the lenient wire allows (visibility, trimmed labels). */
export function normalizeStages(stages: readonly PipelineStageJson[]): PipelineStageJson[] {
  return stages.map((stage) => ({
    id: stage.id.trim(),
    label: stage.label.trim(),
    kanbanVisible: stage.kanbanVisible !== false,
    ...(stage.terminal === true ? { terminal: true } : {}),
    ...(stage.outcomes !== undefined && stage.outcomes.length > 0
      ? {
          outcomes: stage.outcomes.map((rule) => ({
            outcome: rule.outcome.trim(),
            ...(rule.toStageId !== undefined && rule.toStageId.trim() !== ''
              ? { toStageId: rule.toStageId.trim() }
              : {}),
          })),
        }
      : {}),
    ...(stage.requiresOutcome === true ? { requiresOutcome: true } : {}),
    ...(stage.errorReturnToStageId !== undefined && stage.errorReturnToStageId.trim() !== ''
      ? { errorReturnToStageId: stage.errorReturnToStageId.trim() }
      : {}),
  }));
}

/** Whether a save would change the definition (name, stages, or steps). */
export function sameDefinition(current: Pipeline, next: PipelineJson, name: string): boolean {
  return (
    current.name === name &&
    JSON.stringify(normalizeStages(current.stages.map((stage) => stage.toWire()))) ===
      JSON.stringify(normalizeStages(next.stages)) &&
    JSON.stringify(current.steps.map((step) => step.toWire())) === JSON.stringify(next.steps)
  );
}

/** The per-kind fields a pipeline step must carry (v1 M3). */
export function missingStepField(step: PipelineStepJson): string | null {
  switch (step.kind) {
    case 'agent':
      if (step.agentKind === undefined || step.agentKind === '') {
        return 'an agent step needs an agentKind';
      }
      if (step.instructions === undefined || step.instructions.trim() === '') {
        return 'an agent step needs instructions';
      }
      return null;
    case 'command':
      if (step.command === undefined || step.command.trim() === '') {
        return 'a command step needs a command';
      }
      return null;
    case 'human':
      if (step.description === undefined || step.description.trim() === '') {
        return 'a human step needs a description (the approval prompt)';
      }
      return null;
  }
}