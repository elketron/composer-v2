// The user-authored pipeline and its steps (dual representation): `fromWire`
// /`toWire()` on each class, immutable instances, and the step queries as
// methods — the forward path, the Kanban projection, and the terminal rule
// are the pipeline's own concepts, answered here once (the processor, the
// runner, and the snapshot all read them from these objects).
//
// A pipeline is one ordered list of steps. A step that is board-visible is
// its own board swimlane (column); a hidden step runs inside the previous
// visible step's swimlane. The action-envelope parsing and the draft
// validation/normalization live in the codec and draft modules, not here
// (SRV-008).

import type {
  Pipeline as PipelineJson,
  PipelineStep as PipelineStepJson,
  PipelineStepKind,
  StepOutcomeRule,
} from '../wire/models.js';

/** One step of a user-authored pipeline: a board-visible swimlane plus its execution (when present). */
export class PipelineStep {
  readonly id: string;
  readonly kind: PipelineStepKind;
  /** Whether the step becomes a board swimlane (the first step must). */
  readonly boardVisible: boolean;
  /** The completion step; exactly one per pipeline, and it must be last. */
  readonly terminal?: boolean;
  readonly agentKind?: string;
  readonly instructions?: string;
  readonly command?: string;
  readonly description?: string;
  readonly outcomes?: readonly StepOutcomeRule[];
  readonly requiresOutcome?: boolean;
  readonly errorReturnToStepId?: string;

  constructor(json: PipelineStepJson) {
    this.id = json.id;
    this.kind = json.kind;
    this.boardVisible = json.boardVisible;
    if (json.terminal === true) this.terminal = true;
    if (json.agentKind !== undefined) this.agentKind = json.agentKind;
    if (json.instructions !== undefined) this.instructions = json.instructions;
    if (json.command !== undefined) this.command = json.command;
    if (json.description !== undefined) this.description = json.description;
    if (json.outcomes !== undefined) this.outcomes = json.outcomes.map((rule) => ({ ...rule }));
    if (json.requiresOutcome === true) this.requiresOutcome = true;
    if (json.errorReturnToStepId !== undefined) this.errorReturnToStepId = json.errorReturnToStepId;
  }

  static fromWire(json: PipelineStepJson): PipelineStep {
    return new PipelineStep(json);
  }

  /** The swimlane/lane name the board and prompts show for the step. */
  get label(): string {
    if (this.terminal) return 'done';
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
      boardVisible: this.boardVisible,
      ...(this.terminal === true ? { terminal: true } : {}),
      ...(this.agentKind !== undefined ? { agentKind: this.agentKind } : {}),
      ...(this.instructions !== undefined ? { instructions: this.instructions } : {}),
      ...(this.command !== undefined ? { command: this.command } : {}),
      ...(this.description !== undefined ? { description: this.description } : {}),
      ...(this.outcomes !== undefined && this.outcomes.length > 0
        ? { outcomes: this.outcomes.map((rule) => ({ ...rule })) }
        : {}),
      ...(this.requiresOutcome === true ? { requiresOutcome: true } : {}),
      ...(this.errorReturnToStepId !== undefined ? { errorReturnToStepId: this.errorReturnToStepId } : {}),
    };
  }

  /** What the step needs per kind — the server validates the same rule. */
  missingField(): string | null {
    switch (this.kind) {
      case 'agent':
        if (!this.agentKind?.trim()) return 'an agent step needs an agentKind';
        if (!this.instructions?.trim()) return 'an agent step needs instructions';
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

/** A user-authored pipeline: one ordered list of steps. */
export class Pipeline {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  /** 1-based; a save that changes the definition allocates the next revision. */
  readonly revision: number;
  /** The ordered steps (index = forward order). */
  readonly steps: readonly PipelineStep[];
  readonly updatedAt: string;

  constructor(json: PipelineJson) {
    this.id = json.id;
    this.projectId = json.projectId;
    this.name = json.name;
    this.revision = json.revision;
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
      steps: this.steps.map((step) => step.toWire()),
      updatedAt: this.updatedAt,
    };
  }

  stepById(id: string): PipelineStep | undefined {
    return this.steps.find((step) => step.id === id);
  }

  /** The step's forward order (absent = -1). */
  stepOrder(id: string): number {
    return this.steps.findIndex((step) => step.id === id);
  }

  /** The pipeline's first step — a new or reopened card begins here. */
  firstStep(): PipelineStep {
    return this.steps[0]!;
  }

  /** Whether a step id is the pipeline's terminal (completion) step. */
  isTerminalStep(stepId: string): boolean {
    return this.stepById(stepId)?.terminal === true;
  }

  /** The completion step's id (exactly one per pipeline). */
  get terminalStepId(): string | undefined {
    return this.steps.find((step) => step.terminal === true)?.id;
  }

  /**
   * The card's visible board swimlane: the last board-visible step at or
   * before its step in the forward path (hidden steps project backward).
   */
  visibleStepOf(stepId: string): string | undefined {
    const order = this.stepOrder(stepId);
    if (order < 0) return undefined;
    for (let index = order; index >= 0; index--) {
      const step = this.steps[index];
      if (step?.boardVisible) return step.id;
    }
    return undefined;
  }

  /** The board swimlanes: the board-visible steps, in forward order. */
  columns(): readonly PipelineStep[] {
    return this.steps.filter((step) => step.boardVisible);
  }
}