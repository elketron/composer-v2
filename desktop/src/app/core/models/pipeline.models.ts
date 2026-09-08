import {
  PipelineJson,
  PipelineStageJson,
  PipelineStepJson,
  WirePipelineRunStatus,
  WirePipelineStepKind,
} from '../events/wire';
import { Bot, SquareCheck, Terminal, type LucideIconData } from 'lucide-angular';

/** The kind of work one pipeline step does (v1 M3, D7). */
export type PipelineStepKind = WirePipelineStepKind;

/** The state of a pipeline run (Phase 10: runs are first-class records). */
export type PipelineRunStatus = WirePipelineRunStatus;

export interface PipelineStageData {
  readonly id: string;
  readonly label: string;
  readonly kanbanVisible: boolean;
  readonly terminal?: boolean;
  /** The named outcomes an agent step in this stage may report (S36 enforces). */
  readonly outcomes?: readonly { readonly outcome: string; readonly toStageId?: string }[];
  /** Agent steps in this stage must signal their outcome through the tool (S36). */
  readonly requiresOutcome?: boolean;
  /** A failed step in this stage returns the task to this earlier stage. */
  readonly errorReturnToStageId?: string;
}

/** One stage of a pipeline's forward path. Immutable. */
export class PipelineStage {
  constructor(readonly data: PipelineStageData) {}

  get id(): string {
    return this.data.id;
  }

  get label(): string {
    return this.data.label;
  }

  get kanbanVisible(): boolean {
    return this.data.kanbanVisible;
  }

  get terminal(): boolean {
    return this.data.terminal === true;
  }

  get errorReturnToStageId(): string | undefined {
    return this.data.errorReturnToStageId;
  }

  with(changes: Partial<PipelineStageData>): PipelineStage {
    return new PipelineStage({ ...this.data, ...changes });
  }

  toWire(): PipelineStageJson {
    const { id, label } = this.data;
    return {
      id,
      label,
      kanbanVisible: this.data.kanbanVisible,
      ...(this.data.terminal ? { terminal: true } : {}),
      ...(this.data.outcomes?.length
        ? { outcomes: this.data.outcomes.map((rule) => ({ ...rule })) }
        : {}),
      ...(this.data.requiresOutcome ? { requiresOutcome: true } : {}),
      ...(this.data.errorReturnToStageId ? { errorReturnToStageId: this.data.errorReturnToStageId } : {}),
    };
  }
}

export interface PipelineStepData {
  readonly id: string;
  readonly kind: PipelineStepKind;
  /** The stage of this pipeline the step works in. */
  readonly stageId: string;
  readonly agentKind?: string;
  readonly instructions?: string;
  readonly command?: string;
  readonly description?: string;
}

/** One step of a user-authored pipeline. Immutable. */
export class PipelineStep {
  constructor(readonly data: PipelineStepData) {}

  get id(): string {
    return this.data.id;
  }

  get kind(): PipelineStepKind {
    return this.data.kind;
  }

  get stageId(): string {
    return this.data.stageId;
  }

  get agentKind(): string | undefined {
    return this.data.agentKind;
  }

  get instructions(): string | undefined {
    return this.data.instructions;
  }

  get command(): string | undefined {
    return this.data.command;
  }

  get description(): string | undefined {
    return this.data.description;
  }

  with(changes: Partial<PipelineStepData>): PipelineStep {
    return new PipelineStep({ ...this.data, ...changes });
  }

  toWire(): PipelineStepJson {
    const { id, kind, stageId } = this.data;
    return {
      id,
      kind,
      stageId,
      ...(this.data.agentKind ? { agentKind: this.data.agentKind } : {}),
      ...(this.data.instructions ? { instructions: this.data.instructions } : {}),
      ...(this.data.command ? { command: this.data.command } : {}),
      ...(this.data.description ? { description: this.data.description } : {}),
    };
  }

  /** What the step needs per kind — the server validates the same rule. */
  missingField(): string | null {
    switch (this.data.kind) {
      case 'agent':
        if (!this.data.agentKind?.trim()) return 'an agent step needs an agentKind';
        if (!this.data.instructions?.trim()) return 'an agent step needs instructions';
        return null;
      case 'command':
        if (!this.data.command?.trim()) return 'a command step needs a command';
        return null;
      case 'human':
        if (!this.data.description?.trim()) return 'a human step needs a description (the approval prompt)';
        return null;
    }
  }

  static empty(id: string, kind: PipelineStepKind, stageId: string): PipelineStep {
    return new PipelineStep({ id, kind, stageId });
  }
}

export interface PipelineData {
  readonly id: string;
  readonly name: string;
  /** 1-based; the server allocates the next revision on a changed save. */
  readonly revision: number;
  /** The ordered stage path (index = forward order). */
  readonly stages: readonly PipelineStage[];
  /** The ordered execution steps (each references a stage of this pipeline). */
  readonly steps: readonly PipelineStep[];
}

/** A user-authored pipeline (the ownership rule: pipelines are user-authored). */
export class Pipeline {
  constructor(readonly data: PipelineData) {}

  get id(): string {
    return this.data.id;
  }

  get name(): string {
    return this.data.name;
  }

  get revision(): number {
    return this.data.revision;
  }

  get stages(): readonly PipelineStage[] {
    return this.data.stages;
  }

  get steps(): readonly PipelineStep[] {
    return this.data.steps;
  }

  get terminalStageId(): string | undefined {
    return this.data.stages.find((stage) => stage.terminal)?.id;
  }

  stageById(id: string): PipelineStage | undefined {
    return this.data.stages.find((stage) => stage.id === id);
  }

  stageOrder(id: string): number {
    return this.data.stages.findIndex((stage) => stage.id === id);
  }

  stepById(id: string): PipelineStep | undefined {
    return this.data.steps.find((step) => step.id === id);
  }

  /**
   * The card's Kanban column: the last visible stage at or before its
   * stage in the forward path (hidden stages project backward).
   */
  visibleStageOf(stageId: string): string | undefined {
    const order = this.stageOrder(stageId);
    if (order < 0) return undefined;
    for (let index = order; index >= 0; index--) {
      const stage = this.data.stages[index];
      if (stage?.kanbanVisible) return stage.id;
    }
    return undefined;
  }

  /** The Kanban columns: the visible stages, in forward order. */
  columns(): readonly PipelineStage[] {
    return this.data.stages.filter((stage) => stage.kanbanVisible);
  }

  /**
   * Execution inside a hidden stage: the card stays in its previous visible
   * column and this labels where the run actually is (null = visible).
   */
  hiddenStageLabel(stageId: string): string | null {
    if (this.visibleStageOf(stageId) === stageId) return null;
    return this.stageById(stageId)?.label ?? stageId;
  }

  /** The run line's step summary (approval / command / the agent kind). */
  stepSummary(stepId: string | undefined): string | null {
    if (stepId === undefined) return null;
    const step = this.stepById(stepId);
    if (step === undefined) return null;
    if (step.kind === 'human') return 'approval';
    if (step.kind === 'command') return step.description ?? 'command';
    return step.agentKind ?? 'agent';
  }

  with(changes: Partial<PipelineData>): Pipeline {
    return new Pipeline({ ...this.data, ...changes });
  }

  toWire(): PipelineJson {
    return {
      id: this.data.id,
      projectId: '',
      name: this.data.name,
      revision: this.data.revision,
      stages: this.data.stages.map((stage) => stage.toWire()),
      steps: this.data.steps.map((step) => step.toWire()),
      updatedAt: '',
    };
  }

  static fromWire(json: PipelineJson): Pipeline {
    return new Pipeline({
      id: json.id ?? '',
      name: json.name ?? '',
      revision: json.revision ?? 1,
      stages: (json.stages ?? []).map(
        (stage) =>
          new PipelineStage({
            id: stage.id ?? '',
            label: stage.label ?? '',
            kanbanVisible: stage.kanbanVisible !== false,
            ...(stage.terminal ? { terminal: true } : {}),
            ...(stage.outcomes?.length
              ? { outcomes: stage.outcomes.map((rule) => ({ ...rule })) }
              : {}),
            ...(stage.requiresOutcome ? { requiresOutcome: true } : {}),
            ...(stage.errorReturnToStageId ? { errorReturnToStageId: stage.errorReturnToStageId } : {}),
          }),
      ),
      steps: (json.steps ?? []).map(
        (step) =>
          new PipelineStep({
            id: step.id ?? '',
            kind: step.kind ?? 'agent',
            stageId: step.stageId ?? '',
            ...(step.agentKind ? { agentKind: step.agentKind } : {}),
            ...(step.instructions ? { instructions: step.instructions } : {}),
            ...(step.command ? { command: step.command } : {}),
            ...(step.description ? { description: step.description } : {}),
          }),
      ),
    });
  }
}

/** Where a card's pipeline run is (one active run per card). */
export interface RunProgress {
  readonly runId: string;
  readonly pipelineId: string;
  /** The pipeline revision the run pinned at start. */
  readonly revision: number;
  readonly status: 'running' | 'waiting';
  readonly stageId?: string;
  readonly stepId?: string;
  readonly stepKind?: PipelineStepKind;
  /** RFC 3339 timestamp of the current step's start (the run view's elapsed). */
  readonly stepStartedAt?: string;
  /** The agent session the current agent step opened (the run view's transcript). */
  readonly sessionId?: string;
}

/** How a card's most recent run ended (the board's outcome projection). */
export interface RunOutcome {
  readonly runId: string;
  readonly status: PipelineRunStatus;
  /** The finished run's agent session (its transcript outlives the run). */
  readonly sessionId?: string;
  readonly error?: string;
}

// ---- Run representation (the board card's run chip) ----

/** The run chip's label for a run's current step kind. */
export function runLabel(run: RunProgress | undefined): string | null {
  if (run === undefined) return null;
  switch (run.stepKind) {
    case 'agent':
      return 'agent';
    case 'command':
      return 'command';
    case 'human':
      return 'approval';
    default:
      return 'queued';
  }
}

/** The run chip's icon for a run's current step kind. */
export function runIcon(run: RunProgress | undefined): LucideIconData {
  switch (run?.stepKind) {
    case 'command':
      return Terminal;
    case 'human':
      return SquareCheck;
    default:
      return Bot;
  }
}

/** mm:ss since the current step started (empty before a step starts). */
export function runElapsed(run: RunProgress | undefined, now: number): string {
  const startedIso = run?.stepStartedAt;
  const started = startedIso ? Date.parse(startedIso) : Number.NaN;
  if (Number.isNaN(started)) return '';
  const seconds = Math.max(0, Math.round((now - started) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}
