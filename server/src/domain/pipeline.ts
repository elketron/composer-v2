// The user-authored pipeline, its lanes, and its steps (dual representation):
// `fromWire`/`toWire()` on each class, immutable instances, and the step/lane
// queries as methods — the forward path, the Kanban projection, and the
// terminal rule are the pipeline's own concepts, answered here once (the
// processor, the runner, and the snapshot all read them from these objects).
//
// A pipeline owns two independent orderings: the board's lanes (columns, the
// presentation a card sits in) and the executable steps (each bound to a lane).
// A lane may hold several steps or none (the terminal Done lane has no step).

import type {
  Pipeline as PipelineJson,
  PipelineLane as PipelineLaneJson,
  PipelineStep as PipelineStepJson,
  PipelineStepKind,
  StepOutcomeRule,
} from '../wire/models.js';

/** One board lane of a pipeline: a swimlane/column a card sits in. */
export class PipelineLane {
  readonly id: string;
  readonly label: string;
  readonly kanbanVisible: boolean;
  readonly terminal?: boolean;

  constructor(json: PipelineLaneJson) {
    this.id = json.id;
    this.label = json.label;
    this.kanbanVisible = json.kanbanVisible;
    if (json.terminal === true) this.terminal = true;
  }

  static fromWire(json: PipelineLaneJson): PipelineLane {
    return new PipelineLane(json);
  }

  toWire(): PipelineLaneJson {
    return {
      id: this.id,
      label: this.label,
      kanbanVisible: this.kanbanVisible,
      ...(this.terminal === true ? { terminal: true } : {}),
    };
  }
}

/** One executable step of a user-authored pipeline, bound to a lane. */
export class PipelineStep {
  readonly id: string;
  readonly kind: PipelineStepKind;
  readonly laneId: string;
  readonly agentKind?: string;
  readonly instructions?: string;
  readonly command?: string;
  readonly description?: string;
  readonly outcomes?: readonly StepOutcomeRule[];
  readonly requiresOutcome?: boolean;
  readonly errorReturnToLaneId?: string;

  constructor(json: PipelineStepJson) {
    this.id = json.id;
    this.kind = json.kind;
    this.laneId = json.laneId;
    if (json.agentKind !== undefined) this.agentKind = json.agentKind;
    if (json.instructions !== undefined) this.instructions = json.instructions;
    if (json.command !== undefined) this.command = json.command;
    if (json.description !== undefined) this.description = json.description;
    if (json.outcomes !== undefined) this.outcomes = json.outcomes.map((rule) => ({ ...rule }));
    if (json.requiresOutcome === true) this.requiresOutcome = true;
    if (json.errorReturnToLaneId !== undefined) this.errorReturnToLaneId = json.errorReturnToLaneId;
  }

  static fromWire(json: PipelineStepJson): PipelineStep {
    return new PipelineStep(json);
  }

  /** The step's own label for prompts (outcome briefs name the target lane). */
  get label(): string {
    switch (this.kind) {
      case 'agent':
        return this.agentKind?.trim() || 'agent';
      case 'command':
        return this.description?.trim() || 'command';
      case 'human':
        return 'approval';
    }
  }

  toWire(): PipelineStepJson {
    return {
      id: this.id,
      kind: this.kind,
      laneId: this.laneId,
      ...(this.agentKind !== undefined ? { agentKind: this.agentKind } : {}),
      ...(this.instructions !== undefined ? { instructions: this.instructions } : {}),
      ...(this.command !== undefined ? { command: this.command } : {}),
      ...(this.description !== undefined ? { description: this.description } : {}),
      ...(this.outcomes !== undefined && this.outcomes.length > 0
        ? { outcomes: this.outcomes.map((rule) => ({ ...rule })) }
        : {}),
      ...(this.requiresOutcome === true ? { requiresOutcome: true } : {}),
      ...(this.errorReturnToLaneId !== undefined ? { errorReturnToLaneId: this.errorReturnToLaneId } : {}),
    };
  }

  /** What the step needs per kind — the server validates the same rule. */
  missingField(): string | null {
    switch (this.kind) {
      case 'agent':
        if (!this.agentKind?.trim()) return 'an agent step needs an agent';
        return null;
      case 'command':
        if (!this.command?.trim()) return 'a command step needs a command';
        return null;
      case 'human':
        if (!this.description?.trim()) return 'a human step needs a description (the approval prompt)';
        return null;
    }
  }
}

/** A user-authored pipeline: ordered lanes (presentation) and ordered steps (execution). */
export class Pipeline {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  /** The editor's sidebar group (absent = the "General" group). */
  readonly category?: string;
  /** 1-based; a save that changes the definition allocates the next revision. */
  readonly revision: number;
  /** The board's lanes, in forward presentation order. */
  readonly lanes: readonly PipelineLane[];
  /** The ordered executable steps (index = forward execution order). */
  readonly steps: readonly PipelineStep[];
  readonly updatedAt: string;

  constructor(json: PipelineJson) {
    this.id = json.id;
    this.projectId = json.projectId;
    this.name = json.name;
    if (json.category !== undefined) this.category = json.category;
    this.revision = json.revision;
    this.lanes = json.lanes.map((lane) => new PipelineLane(lane));
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
      ...(this.category !== undefined ? { category: this.category } : {}),
      revision: this.revision,
      lanes: this.lanes.map((lane) => lane.toWire()),
      steps: this.steps.map((step) => step.toWire()),
      updatedAt: this.updatedAt,
    };
  }

  stepById(id: string): PipelineStep | undefined {
    return this.steps.find((step) => step.id === id);
  }

  laneById(id: string): PipelineLane | undefined {
    return this.lanes.find((lane) => lane.id === id);
  }

  /** The step's forward execution order (absent = -1). */
  stepOrder(id: string): number {
    return this.steps.findIndex((step) => step.id === id);
  }

  /** The lane's forward presentation order (absent = -1). */
  laneOrder(id: string): number {
    return this.lanes.findIndex((lane) => lane.id === id);
  }

  /** The pipeline's first lane — a new or reopened card begins here. */
  firstLaneId(): string {
    return this.lanes[0]?.id ?? '';
  }

  /** Whether a lane is the pipeline's terminal (completion) lane. */
  isTerminalLane(laneId: string): boolean {
    return this.laneById(laneId)?.terminal === true;
  }

  /** The completion lane's id (exactly one per pipeline). */
  get terminalLaneId(): string | undefined {
    return this.lanes.find((lane) => lane.terminal === true)?.id;
  }

  /** The board columns: the kanban-visible lanes, in forward order. */
  columns(): readonly PipelineLane[] {
    return this.lanes.filter((lane) => lane.kanbanVisible);
  }

  /** The lane's presentation label (falls back to the id). */
  laneLabel(laneId: string): string {
    return this.laneById(laneId)?.label ?? laneId;
  }
}