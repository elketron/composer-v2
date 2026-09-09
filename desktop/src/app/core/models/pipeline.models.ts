import {
  PipelineJson,
  PipelineStepJson,
  WirePipelineRunStatus,
  WirePipelineStepKind,
} from '../events/wire';
import { Bot, SquareCheck, Terminal, type LucideIconData } from 'lucide-angular';

/** The kind of work one pipeline step does (v1 M3, D7). */
export type PipelineStepKind = WirePipelineStepKind;

/** The state of a pipeline run (Phase 10: runs are first-class records). */
export type PipelineRunStatus = WirePipelineRunStatus;

/**
 * The shipped pipeline agent kinds (mirror of server/src/agents/names.ts):
 * an agent step names exactly one of these — the backend agents it ships.
 */
export const PIPELINE_AGENT_KINDS: readonly string[] = ['coder', 'tester', 'reviewer', 'security'];

/** A predefined agent the step editor selects (server catalog entry). */
export interface PipelineAgentCatalogEntry {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

/** A predefined runtime (terminal) step the step editor selects. */
export interface RuntimeStepCatalogEntry {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly description: string;
}

/** The server's executor catalog (GET /catalog). */
export interface PipelineCatalog {
  readonly agents: readonly PipelineAgentCatalogEntry[];
  readonly runtimeSteps: readonly RuntimeStepCatalogEntry[];
}

/** One agent-reported named outcome and where it routes. */
export interface StepOutcomeRule {
  readonly outcome: string;
  readonly toStepId?: string;
}

export interface PipelineStepData {
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
}

/** One step of a user-authored pipeline: a board-visible swimlane plus its execution. Immutable. */
export class PipelineStep {
  constructor(readonly data: PipelineStepData) {}

  get id(): string {
    return this.data.id;
  }

  get kind(): PipelineStepKind {
    return this.data.kind;
  }

  get boardVisible(): boolean {
    return this.data.boardVisible;
  }

  get terminal(): boolean {
    return this.data.terminal === true;
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

  get outcomes(): readonly StepOutcomeRule[] {
    return this.data.outcomes ?? [];
  }

  get requiresOutcome(): boolean {
    return this.data.requiresOutcome === true;
  }

  get errorReturnToStepId(): string | undefined {
    return this.data.errorReturnToStepId;
  }

  /** The swimlane/lane label the board and editor show for the step. */
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

  with(changes: Partial<PipelineStepData>): PipelineStep {
    return new PipelineStep({ ...this.data, ...changes });
  }

  toWire(): PipelineStepJson {
    const { id, kind } = this.data;
    return {
      id,
      kind,
      boardVisible: this.data.boardVisible,
      ...(this.data.terminal ? { terminal: true } : {}),
      ...(this.data.agentKind ? { agentKind: this.data.agentKind } : {}),
      ...(this.data.instructions ? { instructions: this.data.instructions } : {}),
      ...(this.data.command ? { command: this.data.command } : {}),
      ...(this.data.description ? { description: this.data.description } : {}),
      ...(this.data.outcomes?.length
        ? { outcomes: this.data.outcomes.map((rule) => ({ ...rule })) }
        : {}),
      ...(this.data.requiresOutcome ? { requiresOutcome: true } : {}),
      ...(this.data.errorReturnToStepId ? { errorReturnToStepId: this.data.errorReturnToStepId } : {}),
    };
  }

  /** What the step needs per kind — the server validates the same rule. */
  missingField(): string | null {
    switch (this.data.kind) {
      case 'agent':
        if (!this.data.agentKind?.trim()) return 'an agent step needs an agent';
        // The selected agent owns its instructions; a step only names the agent.
        return null;
      case 'command':
        if (!this.data.command?.trim()) return 'a command step needs a command';
        return null;
      case 'human':
        if (!this.data.description?.trim()) return 'a human step needs a description (the approval prompt)';
        return null;
    }
  }

  static empty(id: string, kind: PipelineStepKind): PipelineStep {
    return new PipelineStep({ id, kind, boardVisible: true });
  }
}

export interface PipelineData {
  readonly id: string;
  readonly name: string;
  /** 1-based; the server allocates the next revision on a changed save. */
  readonly revision: number;
  /** The ordered steps (index = forward order; each board-visible step is a swimlane). */
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

  get steps(): readonly PipelineStep[] {
    return this.data.steps;
  }

  get terminalStepId(): string | undefined {
    return this.data.steps.find((step) => step.terminal)?.id;
  }

  stepById(id: string): PipelineStep | undefined {
    return this.data.steps.find((step) => step.id === id);
  }

  stepOrder(id: string): number {
    return this.data.steps.findIndex((step) => step.id === id);
  }

  firstStep(): PipelineStep {
    return this.data.steps[0]!;
  }

  /**
   * The card's board swimlane: the last board-visible step at or before its
   * step in the forward path (hidden steps project backward).
   */
  visibleStepOf(stepId: string): string | undefined {
    const order = this.stepOrder(stepId);
    if (order < 0) return undefined;
    for (let index = order; index >= 0; index--) {
      const step = this.data.steps[index];
      if (step?.boardVisible) return step.id;
    }
    return undefined;
  }

  /** The board swimlanes: the board-visible steps, in forward order. */
  columns(): readonly PipelineStep[] {
    return this.data.steps.filter((step) => step.boardVisible);
  }

  /**
   * Execution inside a hidden step: the card stays in its previous visible
   * swimlane and this labels where the run actually is (null = visible).
   */
  hiddenStepLabel(stepId: string): string | null {
    if (this.visibleStepOf(stepId) === stepId) return null;
    return this.stepById(stepId)?.label ?? stepId;
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
      steps: this.data.steps.map((step) => step.toWire()),
      updatedAt: '',
    };
  }

  static fromWire(json: PipelineJson): Pipeline {
    return new Pipeline({
      id: json.id ?? '',
      name: json.name ?? '',
      revision: json.revision ?? 1,
      steps: (json.steps ?? []).map(
        (step) =>
          new PipelineStep({
            id: step.id ?? '',
            kind: step.kind ?? 'agent',
            boardVisible: step.boardVisible !== false,
            ...(step.terminal ? { terminal: true } : {}),
            ...(step.agentKind ? { agentKind: step.agentKind } : {}),
            ...(step.instructions ? { instructions: step.instructions } : {}),
            ...(step.command ? { command: step.command } : {}),
            ...(step.description ? { description: step.description } : {}),
            ...(step.outcomes?.length
              ? { outcomes: step.outcomes.map((rule) => ({ ...rule })) }
              : {}),
            ...(step.requiresOutcome ? { requiresOutcome: true } : {}),
            ...(step.errorReturnToStepId ? { errorReturnToStepId: step.errorReturnToStepId } : {}),
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
  /** A successful named outcome that routed the card (e.g. changes_requested). */
  readonly outcome?: string;
  /** The reviewer/human feedback the routed card carries back. */
  readonly feedback?: string;
  readonly routedToStepId?: string;
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