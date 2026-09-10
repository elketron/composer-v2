// The pipeline draft validation and normalization (SRV-008): the save
// command's rules — name, lanes (presentation), steps (execution), the
// forward path, the terminal lane, and the per-kind step fields — plus the
// normalization and the same-definition comparison.

import type {
  Pipeline as PipelineJson,
  PipelineLane as PipelineLaneJson,
  PipelineStep as PipelineStepJson,
} from '../wire/models.js';
import type { Pipeline } from './pipeline.js';
import { CommandRejection } from './rejection.js';
import { PIPELINE_AGENT_KINDS } from '../agents/names.js';

/** Ceiling on lanes/steps one pipeline may carry (v1 M3). */
export const MAX_PIPELINE_STEPS = 64;

/** Ceiling on the category label (editor presentation metadata only). */
export const MAX_PIPELINE_CATEGORY = 32;

/** A validated draft's normalized category, lanes and steps. */
export interface NormalizedDraft {
  category?: string;
  lanes: PipelineLaneJson[];
  steps: PipelineStepJson[];
}

/** The normalized category: trimmed, capped, absent when blank (lenient — the editor groups unknown values under General). */
function normalizeCategory(category: string | undefined): string | undefined {
  const trimmed = category?.trim() ?? '';
  return trimmed === '' ? undefined : trimmed.slice(0, MAX_PIPELINE_CATEGORY);
}

/**
 * Validates a user-authored draft in full — name, lanes, steps, the forward
 * path, the terminal lane — and returns the normalized lanes and steps the
 * save publishes.
 */
export function validateDraft(draft: PipelineJson): NormalizedDraft {
  const rejection = (message: string): CommandRejection => new CommandRejection('invalidCommand', message);
  if (draft.name.trim() === '') {
    throw rejection('Pipeline name is required');
  }

  // Validate user input before normalization drops empty optional fields.
  for (const [index, step] of draft.steps.entries()) {
    for (const outcome of step.outcomes ?? []) {
      if (outcome.outcome.trim() === '') {
        throw rejection(`Step ${index + 1}: an outcome needs a name`);
      }
    }
  }

  const lanes = normalizeLanes(draft.lanes);
  const steps = normalizeSteps(draft.steps);

  if (lanes.length === 0) {
    throw rejection('A pipeline needs at least one lane');
  }
  if (lanes.length > MAX_PIPELINE_STEPS) {
    throw rejection(`Pipeline has ${lanes.length} lanes; the limit is ${MAX_PIPELINE_STEPS}`);
  }
  if (steps.length === 0) {
    throw rejection('A pipeline needs at least one step');
  }
  if (steps.length > MAX_PIPELINE_STEPS) {
    throw rejection(`Pipeline has ${steps.length} steps; the limit is ${MAX_PIPELINE_STEPS}`);
  }

  const laneIds = new Set<string>();
  for (const [index, lane] of lanes.entries()) {
    const label = `Lane ${index + 1}`;
    if (lane.id === '') throw rejection(`${label} needs an id`);
    if (laneIds.has(lane.id)) throw rejection(`Lane id '${lane.id}' appears twice`);
    laneIds.add(lane.id);
  }

  const stepIds = new Set<string>();
  for (const [index, step] of steps.entries()) {
    const label = `Step ${index + 1}`;
    if (step.id === '') throw rejection(`${label} needs an id`);
    if (stepIds.has(step.id)) throw rejection(`Step id '${step.id}' appears twice`);
    stepIds.add(step.id);
    if (!laneIds.has(step.laneId)) throw rejection(`${label}: lane '${step.laneId}' is not a lane of the pipeline`);
  }

  for (const [index, step] of steps.entries()) {
    const label = `Step ${index + 1}`;
    if (step.kind === 'agent') {
      const agentKind = step.agentKind?.trim() ?? '';
      if (agentKind !== '' && !PIPELINE_AGENT_KINDS.includes(agentKind)) {
        throw rejection(`${label}: agent kind '${agentKind}' has no implementation yet`);
      }
    }
    const outcomeNames: string[] = [];
    for (const outcome of step.outcomes ?? []) {
      if (outcome.outcome.trim() === '') throw rejection(`${label}: an outcome needs a name`);
      outcomeNames.push(outcome.outcome.trim());
      if (outcome.toLaneId !== undefined) {
        assertEarlierLane(lanes, step.laneId, outcome.toLaneId, `outcome '${outcome.outcome}'`, label, rejection);
      }
    }
    if (new Set(outcomeNames).size !== outcomeNames.length) {
      throw rejection(`${label}: outcome names must be unique`);
    }
    if (step.errorReturnToLaneId !== undefined) {
      assertEarlierLane(lanes, step.laneId, step.errorReturnToLaneId, 'the error condition', label, rejection);
    }
    const message = missingStepField(step);
    if (message !== null) throw rejection(`${label}: ${message}`);
  }

  const terminals = lanes.filter((lane) => lane.terminal === true);
  if (terminals.length !== 1) throw rejection('A pipeline needs exactly one terminal (Done) lane');
  if (lanes[lanes.length - 1]?.terminal !== true) throw rejection('The terminal lane must be the last lane');
  if (lanes[0]?.kanbanVisible !== true) throw rejection('The first lane must be kanban-visible');
  if (lanes[lanes.length - 1]?.kanbanVisible !== true) throw rejection('The terminal lane must be kanban-visible');

  return { category: normalizeCategory(draft.category), lanes, steps };
}

/** A lane reference must name a strictly-earlier lane than the step's own. */
function assertEarlierLane(
  lanes: readonly PipelineLaneJson[],
  stepLaneId: string,
  targetId: string,
  what: string,
  label: string,
  rejection: (message: string) => CommandRejection,
): void {
  const target = lanes.findIndex((lane) => lane.id === targetId.trim());
  if (target < 0) throw rejection(`${label}: ${what} names an unknown lane`);
  const from = lanes.findIndex((lane) => lane.id === stepLaneId);
  if (target >= from) throw rejection(`${label}: ${what} may only return to an earlier lane`);
}

/** Fills the lane defaults the lenient wire allows (kanban-visible). */
export function normalizeLanes(lanes: readonly PipelineLaneJson[]): PipelineLaneJson[] {
  return lanes.map((lane) => ({
    id: lane.id.trim(),
    label: lane.label.trim(),
    kanbanVisible: lane.kanbanVisible !== false,
    ...(lane.terminal === true ? { terminal: true } : {}),
  }));
}

/** Fills the step defaults the lenient wire allows (trimmed text). */
export function normalizeSteps(steps: readonly PipelineStepJson[]): PipelineStepJson[] {
  return steps.map((step) => ({
    id: step.id.trim(),
    kind: step.kind,
    laneId: step.laneId.trim(),
    ...(step.agentKind !== undefined && step.agentKind.trim() !== '' ? { agentKind: step.agentKind.trim() } : {}),
    ...(step.instructions !== undefined && step.instructions.trim() !== ''
      ? { instructions: step.instructions.trim() }
      : {}),
    ...(step.command !== undefined && step.command.trim() !== '' ? { command: step.command.trim() } : {}),
    ...(step.description !== undefined && step.description.trim() !== ''
      ? { description: step.description.trim() }
      : {}),
    ...(step.outcomes !== undefined && step.outcomes.length > 0
      ? {
          outcomes: step.outcomes
            .map((rule) => ({
              outcome: rule.outcome.trim(),
              ...(rule.toLaneId !== undefined && rule.toLaneId.trim() !== ''
                ? { toLaneId: rule.toLaneId.trim() }
                : {}),
            }))
            .filter((rule) => rule.outcome !== ''),
        }
      : {}),
    ...(step.requiresOutcome === true ? { requiresOutcome: true } : {}),
    ...(step.errorReturnToLaneId !== undefined && step.errorReturnToLaneId.trim() !== ''
      ? { errorReturnToLaneId: step.errorReturnToLaneId.trim() }
      : {}),
  }));
}

/** Whether a save would change the definition (name, category, lanes, or steps). */
export function sameDefinition(current: Pipeline, next: PipelineJson, name: string): boolean {
  return (
    current.name === name &&
    current.category === normalizeCategory(next.category) &&
    JSON.stringify(current.lanes.map((lane) => lane.toWire())) === JSON.stringify(normalizeLanes(next.lanes)) &&
    JSON.stringify(current.steps.map((step) => step.toWire())) === JSON.stringify(normalizeSteps(next.steps))
  );
}

/** The per-kind fields a pipeline step must carry (v1 M3). */
export function missingStepField(step: PipelineStepJson): string | null {
  switch (step.kind) {
    case 'agent':
      if (step.agentKind === undefined || step.agentKind === '') {
        return 'an agent step needs an agent';
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