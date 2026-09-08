// The user-authored pipeline and its stages and steps (dual representation):
// `fromWire`/`toWire()` on each class, immutable instances, and the stage
// queries as methods — the forward path, the Kanban projection, and the
// terminal rule are the pipeline's own concepts, answered here once (the
// processor, the runner, and the snapshot all read them from these objects).

import {
  readString,
  asRecord,
} from '../wire/read.js';
import type {
  Pipeline as PipelineJson,
  PipelineStage as PipelineStageJson,
  PipelineStep as PipelineStepJson,
  PipelineStepKind,
  StageOutcomeRule,
} from '../wire/models.js';
import { CommandRejection } from './rejection.js';

/** Ceiling on steps one pipeline may carry (v1 M3). */
export const MAX_PIPELINE_STEPS = 64;

/** The revision is server-authoritative; a client's value is ignored. */
function readRevision(record: Record<string, unknown>): number {
  return typeof record['revision'] === 'number' ? record['revision'] : 0;
}

/** A timestamp the client actually set (the sentinel '' → absent). */
function readTimestamp(record: Record<string, unknown>, key: string): string {
  const value = readString(record, key);
  return value !== undefined && Date.parse(value) > 0 ? value : '';
}

/**
 * One stage of a pipeline's forward path. Field assignment order matches
 * the wire shape (and the HTTP reader's key order) — `sameDefinition`
 * compares serialized stages, so the orders must agree.
 */
export class PipelineStage {
  readonly id: string;
  readonly label: string;
  /** Whether the stage becomes a Kanban column (the first stage must). */
  readonly kanbanVisible: boolean;
  /** The completion stage; exactly one per pipeline, and it must be last. */
  readonly terminal?: boolean;
  /** The named outcomes an agent step in this stage may report (S36 enforces). */
  readonly outcomes?: readonly StageOutcomeRule[];
  /** Agent steps in this stage must signal their outcome through the tool (S36). */
  readonly requiresOutcome?: boolean;
  /** A failed step in this stage returns the task to this earlier stage (S35). */
  readonly errorReturnToStageId?: string;

  constructor(json: PipelineStageJson) {
    this.id = json.id;
    this.label = json.label;
    this.kanbanVisible = json.kanbanVisible;
    if (json.terminal === true) this.terminal = true;
    if (json.outcomes !== undefined) this.outcomes = json.outcomes.map((rule) => ({ ...rule }));
    if (json.requiresOutcome === true) this.requiresOutcome = true;
    if (json.errorReturnToStageId !== undefined) this.errorReturnToStageId = json.errorReturnToStageId;
  }

  static fromWire(json: PipelineStageJson): PipelineStage {
    return new PipelineStage(json);
  }

  /** The stage the client meant — lenient, defaults where absent. */
  static fromAction(json: unknown): PipelineStageJson {
    const record = asRecord(json);
    const outcomes = Array.isArray(record['outcomes']) ? record['outcomes'] : [];
    return {
      id: readString(record, 'id') ?? '',
      label: readString(record, 'label') ?? '',
      kanbanVisible: record['kanbanVisible'] !== false,
      ...(record['terminal'] === true ? { terminal: true } : {}),
      ...(outcomes.length > 0
        ? {
            outcomes: outcomes.map((rule) => {
              const outcome = asRecord(rule);
              const toStageId = readString(outcome, 'toStageId');
              return {
                outcome: readString(outcome, 'outcome') ?? '',
                ...(toStageId !== undefined && toStageId !== '' ? { toStageId } : {}),
              };
            }),
          }
        : {}),
      ...(record['requiresOutcome'] === true ? { requiresOutcome: true } : {}),
      ...(readString(record, 'errorReturnToStageId') !== undefined
        ? { errorReturnToStageId: readString(record, 'errorReturnToStageId')! }
        : {}),
    };
  }

  toWire(): PipelineStageJson {
    return {
      id: this.id,
      label: this.label,
      kanbanVisible: this.kanbanVisible,
      ...(this.terminal === true ? { terminal: true } : {}),
      ...(this.outcomes !== undefined && this.outcomes.length > 0
        ? { outcomes: this.outcomes.map((rule) => ({ ...rule })) }
        : {}),
      ...(this.requiresOutcome === true ? { requiresOutcome: true } : {}),
      ...(this.errorReturnToStageId !== undefined ? { errorReturnToStageId: this.errorReturnToStageId } : {}),
    };
  }
}

/** One step of a user-authored pipeline: what the run executes, in one of the pipeline's stages. */
export class PipelineStep {
  readonly id: string;
  readonly kind: PipelineStepKind;
  /** The stage of this pipeline the step works in (required). */
  readonly stageId: string;
  readonly agentKind?: string;
  readonly instructions?: string;
  readonly command?: string;
  readonly description?: string;

  constructor(json: PipelineStepJson) {
    this.id = json.id;
    this.kind = json.kind;
    this.stageId = json.stageId;
    if (json.agentKind !== undefined) this.agentKind = json.agentKind;
    if (json.instructions !== undefined) this.instructions = json.instructions;
    if (json.command !== undefined) this.command = json.command;
    if (json.description !== undefined) this.description = json.description;
  }

  static fromWire(json: PipelineStepJson): PipelineStep {
    return new PipelineStep(json);
  }

  /** The step the client meant — lenient, an unknown kind defaults to agent. */
  static fromAction(json: unknown): PipelineStepJson {
    const record = asRecord(json);
    const kind = readString(record, 'kind');
    return {
      id: readString(record, 'id') ?? '',
      kind: kind === 'command' || kind === 'human' ? kind : 'agent',
      stageId: readString(record, 'stageId') ?? '',
      ...(readString(record, 'agentKind') !== undefined ? { agentKind: readString(record, 'agentKind') } : {}),
      ...(readString(record, 'instructions') !== undefined
        ? { instructions: readString(record, 'instructions') }
        : {}),
      ...(readString(record, 'command') !== undefined ? { command: readString(record, 'command') } : {}),
      ...(readString(record, 'description') !== undefined
        ? { description: readString(record, 'description') }
        : {}),
    };
  }

  toWire(): PipelineStepJson {
    return {
      id: this.id,
      kind: this.kind,
      stageId: this.stageId,
      ...(this.agentKind !== undefined ? { agentKind: this.agentKind } : {}),
      ...(this.instructions !== undefined ? { instructions: this.instructions } : {}),
      ...(this.command !== undefined ? { command: this.command } : {}),
      ...(this.description !== undefined ? { description: this.description } : {}),
    };
  }
}

/** A user-authored pipeline: an ordered stage path plus an ordered step list. */
export class Pipeline {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  /** 1-based; a save that changes the definition allocates the next revision. */
  readonly revision: number;
  /** The ordered stage path (index = forward order). */
  readonly stages: readonly PipelineStage[];
  /** The ordered execution steps (each references one of the stages). */
  readonly steps: readonly PipelineStep[];
  readonly updatedAt: string;

  constructor(json: PipelineJson) {
    this.id = json.id;
    this.projectId = json.projectId;
    this.name = json.name;
    this.revision = json.revision;
    this.stages = json.stages.map((stage) => new PipelineStage(stage));
    this.steps = json.steps.map((step) => new PipelineStep(step));
    this.updatedAt = json.updatedAt;
  }

  static fromWire(json: PipelineJson): Pipeline {
    return new Pipeline(json);
  }

  /** The pipeline draft the client meant — stages and steps lenient, per-kind fields as found. */
  static draftFromAction(json: unknown, scopeProjectId: string | undefined): PipelineJson {
    const record = asRecord(json);
    const stages = Array.isArray(record['stages']) ? record['stages'] : [];
    const steps = Array.isArray(record['steps']) ? record['steps'] : [];
    return {
      id: readString(record, 'id') ?? '',
      projectId: readString(record, 'projectId') ?? scopeProjectId ?? '',
      name: readString(record, 'name') ?? '',
      revision: readRevision(record),
      stages: stages.map((stage) => PipelineStage.fromAction(stage)),
      steps: steps.map((step) => PipelineStep.fromAction(step)),
      updatedAt: readTimestamp(record, 'updatedAt'),
    };
  }

  toWire(): PipelineJson {
    return {
      id: this.id,
      projectId: this.projectId,
      name: this.name,
      revision: this.revision,
      stages: this.stages.map((stage) => stage.toWire()),
      steps: this.steps.map((step) => step.toWire()),
      updatedAt: this.updatedAt,
    };
  }

  /** The completion stage's id (exactly one per pipeline). */
  get terminalStageId(): string | undefined {
    return this.stages.find((stage) => stage.terminal === true)?.id;
  }

  stageById(id: string): PipelineStage | undefined {
    return this.stages.find((stage) => stage.id === id);
  }

  /** The stage's forward order (absent = -1). */
  stageOrder(id: string): number {
    return this.stages.findIndex((stage) => stage.id === id);
  }

  stepById(id: string): PipelineStep | undefined {
    return this.steps.find((step) => step.id === id);
  }

  /** The pipeline's first stage — a new or reopened card begins here. */
  firstStage(): PipelineStage {
    return this.stages[0]!;
  }

  /** Whether a stage id is the pipeline's terminal (completion) stage. */
  isTerminalStage(stageId: string): boolean {
    return this.stageById(stageId)?.terminal === true;
  }

  /**
   * The card's visible Kanban column: the last visible stage at or before
   * its stage in the forward path (hidden stages project backward).
   */
  visibleStageOf(stageId: string): string | undefined {
    const order = this.stageOrder(stageId);
    if (order < 0) return undefined;
    for (let index = order; index >= 0; index--) {
      const stage = this.stages[index];
      if (stage?.kanbanVisible) return stage.id;
    }
    return undefined;
  }

  // ---- Draft validation (the save command's transition) ----

  /**
   * Validates a user-authored draft in full — name, stages, the forward
   * path, the terminal stage — and returns the normalized stages the save
   * publishes. Same order, codes, and messages the processor emitted when
   * the validation lived there.
   */
  static validateDraft(draft: PipelineJson): PipelineStageJson[] {
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
    const stages = Pipeline.normalizeStages(draft.stages);
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
          const target = stageOrder.get(outcome.toStageId);
          if (target === undefined) {
            throw rejection(`${label}: outcome '${outcome.outcome}' names an unknown stage`);
          }
          if (target >= index) {
            throw rejection(`${label}: outcome '${outcome.outcome}' may only return to an earlier stage`);
          }
        }
      }
      const outcomeNames = (stage.outcomes ?? []).map((rule) => rule.outcome.trim());
      if (new Set(outcomeNames).size !== outcomeNames.length) {
        throw rejection(`${label}: outcome names must be unique`);
      }
      if (stage.errorReturnToStageId !== undefined) {
        const target = stageOrder.get(stage.errorReturnToStageId);
        if (target === undefined) {
          throw rejection(`${label}: the error condition names an unknown stage`);
        }
        if (target >= index) {
          throw rejection(`${label}: the error condition may only return to an earlier stage`);
        }
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
      const message = Pipeline.missingStepField(step);
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

  /** Fills the stage defaults the lenient wire allows (visibility, trimmed labels). */
  static normalizeStages(stages: readonly PipelineStageJson[]): PipelineStageJson[] {
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
  static sameDefinition(current: Pipeline, next: PipelineJson, name: string): boolean {
    return (
      current.name === name &&
      JSON.stringify(Pipeline.normalizeStages(current.stages.map((stage) => stage.toWire()))) ===
        JSON.stringify(Pipeline.normalizeStages(next.stages)) &&
      JSON.stringify(current.steps.map((step) => step.toWire())) === JSON.stringify(next.steps)
    );
  }

  /** The per-kind fields a pipeline step must carry (v1 M3). */
  static missingStepField(step: PipelineStepJson): string | null {
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
}
