// The pipeline draft validation and normalization (SRV-008): the save
// command's rules — name, steps, the forward path (implicit in a single
// ordered list), the terminal step, and the per-kind step fields — plus the
// step-default normalization and the same-definition comparison. These are
// draft-level concerns, split from the `Pipeline` model (which keeps
// topology and serialization).

import type {
  Pipeline as PipelineJson,
  PipelineStep as PipelineStepJson,
} from '../wire/models.js';
import type { Pipeline } from './pipeline.js';
import { CommandRejection } from './rejection.js';
import { PIPELINE_AGENT_KINDS } from '../agents/names.js';

/** Ceiling on steps one pipeline may carry (v1 M3). */
export const MAX_PIPELINE_STEPS = 64;

/**
 * Validates a user-authored draft in full — name, steps, the forward path,
 * the terminal step — and returns the normalized steps the save publishes.
 * Same order, codes, and messages the processor emitted when validation
 * lived there.
 */
export function validateDraft(draft: PipelineJson): PipelineStepJson[] {
  const rejection = (message: string): CommandRejection => new CommandRejection('invalidCommand', message);
  if (draft.name.trim() === '') {
    throw rejection('Pipeline name is required');
  }
  if (draft.steps.length === 0) {
    throw rejection('A pipeline needs at least one step');
  }
  if (draft.steps.length > MAX_PIPELINE_STEPS) {
    throw rejection(`Pipeline has ${draft.steps.length} steps; the limit is ${MAX_PIPELINE_STEPS}`);
  }

  // Validate user input before normalization drops empty optional fields.
  for (const [index, step] of draft.steps.entries()) {
    for (const outcome of step.outcomes ?? []) {
      if (outcome.outcome.trim() === '') {
        throw rejection(`Step ${index + 1}: an outcome needs a name`);
      }
    }
  }

  const steps = normalizeSteps(draft.steps);
  const seen = new Set<string>();
  for (const [index, step] of steps.entries()) {
    const label = `Step ${index + 1}`;
    if (step.id === '') {
      throw rejection(`${label} needs an id`);
    }
    if (seen.has(step.id)) {
      throw rejection(`Step id '${step.id}' appears twice`);
    }
    seen.add(step.id);
  }

  for (const [index, step] of steps.entries()) {
    const label = `Step ${index + 1}`;
    if (step.kind === 'agent') {
      const agentKind = step.agentKind?.trim() ?? '';
      if (agentKind !== '' && !PIPELINE_AGENT_KINDS.includes(agentKind)) {
        throw rejection(`${label}: agent kind '${agentKind}' has no implementation yet`);
      }
    }
    for (const outcome of step.outcomes ?? []) {
      if (outcome.outcome.trim() === '') {
        throw rejection(`${label}: an outcome needs a name`);
      }
      if (outcome.toStepId !== undefined) {
        assertEarlierStep(steps, index, outcome.toStepId, `outcome '${outcome.outcome}'`, label, rejection);
      }
    }
    const outcomeNames = (step.outcomes ?? []).map((rule) => rule.outcome.trim());
    if (new Set(outcomeNames).size !== outcomeNames.length) {
      throw rejection(`${label}: outcome names must be unique`);
    }
    if (step.errorReturnToStepId !== undefined) {
      assertEarlierStep(steps, index, step.errorReturnToStepId, 'the error condition', label, rejection);
    }
    // A terminal step is a pure swimlane marker: no kind fields required.
    if (step.terminal !== true) {
      const message = missingStepField(step);
      if (message !== null) {
        throw rejection(`${label}: ${message}`);
      }
    }
  }

  const terminals = steps.filter((step) => step.terminal === true);
  if (terminals.length !== 1) {
    throw rejection('A pipeline needs exactly one terminal (Done) step');
  }
  if (!steps.some((step) => step.terminal !== true)) {
    throw rejection('A pipeline needs at least one non-terminal executable step');
  }
  if (steps[steps.length - 1]?.terminal !== true) {
    throw rejection('The terminal step must be the last step');
  }
  if (steps[steps.length - 1]?.boardVisible !== true) {
    throw rejection('The terminal step must be board-visible');
  }
  if (steps[0]?.boardVisible !== true) {
    throw rejection('The first step must be board-visible');
  }
  return steps;
}

/** A step reference must name a known, strictly-earlier step. */
function assertEarlierStep(
  steps: readonly PipelineStepJson[],
  index: number,
  targetId: string,
  what: string,
  label: string,
  rejection: (message: string) => CommandRejection,
): void {
  const target = steps.findIndex((step) => step.id === targetId.trim());
  if (target < 0) {
    throw rejection(`${label}: ${what} names an unknown step`);
  }
  if (target >= index) {
    throw rejection(`${label}: ${what} may only return to an earlier step`);
  }
}

/** Fills the step defaults the lenient wire allows (board-visible, trimmed text). */
export function normalizeSteps(steps: readonly PipelineStepJson[]): PipelineStepJson[] {
  return steps.map((step) => ({
    id: step.id.trim(),
    kind: step.kind,
    boardVisible: step.boardVisible !== false,
    ...(step.terminal === true ? { terminal: true } : {}),
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
              ...(rule.toStepId !== undefined && rule.toStepId.trim() !== ''
                ? { toStepId: rule.toStepId.trim() }
                : {}),
            }))
            .filter((rule) => rule.outcome !== ''),
        }
      : {}),
    ...(step.requiresOutcome === true ? { requiresOutcome: true } : {}),
    ...(step.errorReturnToStepId !== undefined && step.errorReturnToStepId.trim() !== ''
      ? { errorReturnToStepId: step.errorReturnToStepId.trim() }
      : {}),
  }));
}

/** Whether a save would change the definition (name or steps). */
export function sameDefinition(current: Pipeline, next: PipelineJson, name: string): boolean {
  return (
    current.name === name &&
    JSON.stringify(current.steps.map((step) => step.toWire())) === JSON.stringify(normalizeSteps(next.steps))
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
