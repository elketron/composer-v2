// The user-authored pipeline and its stages and steps (dual representation):
// `fromWire`/`toWire()` on each class, immutable instances, and the stage
// queries as methods — the forward path, the Kanban projection, and the
// terminal rule are the pipeline's own concepts, answered here once (the
// processor, the runner, and the snapshot all read them from these objects).

import type {
  Pipeline as PipelineJson,
  PipelineStage as PipelineStageJson,
  PipelineStep as PipelineStepJson,
  PipelineStepKind,
  StageOutcomeRule,
} from '../wire/models.js';

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
}
