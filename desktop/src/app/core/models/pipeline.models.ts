import {
  PipelineJson,
  PipelineLaneJson,
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

/** A sidebar group the pipeline editor organizes pipelines under. */
export interface PipelineCategoryCatalogEntry {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

/** The server's executor catalog (GET /catalog). */
export interface PipelineCatalog {
  readonly agents: readonly PipelineAgentCatalogEntry[];
  readonly runtimeSteps: readonly RuntimeStepCatalogEntry[];
  readonly categories: readonly PipelineCategoryCatalogEntry[];
}

/**
 * The shipped pipeline categories (mirror of server/src/agents/catalog.ts):
 * the sidebar groups the editor organizes pipelines under. Unknown/absent
 * values fall back to General.
 */
export const PIPELINE_CATEGORIES: readonly PipelineCategoryCatalogEntry[] = [
  { id: 'coding', label: 'Coding', description: 'Implementation, review, and delivery of code changes.' },
  { id: 'documentation', label: 'Documentation', description: 'Writing and maintaining project docs.' },
  { id: 'research', label: 'Research', description: 'Investigation and comparison work.' },
  { id: 'release', label: 'Release', description: 'Versioning, changelogs, and shipping.' },
  { id: 'infrastructure', label: 'Infrastructure', description: 'Environments, tooling, and operations.' },
];

/** One agent-reported named outcome and where it routes. */
export interface StepOutcomeRule {
  readonly outcome: string;
  readonly toLaneId?: string;
}

export interface PipelineStepData {
  readonly id: string;
  readonly kind: PipelineStepKind;
  /** The lane the step's work appears in. */
  readonly laneId: string;
  readonly agentKind?: string;
  readonly instructions?: string;
  readonly command?: string;
  readonly description?: string;
  readonly outcomes?: readonly StepOutcomeRule[];
  readonly requiresOutcome?: boolean;
  readonly errorReturnToLaneId?: string;
}

/** One executable step of a user-authored pipeline, bound to a lane. Immutable. */
export class PipelineStep {
  constructor(readonly data: PipelineStepData) {}

  get id(): string {
    return this.data.id;
  }

  get kind(): PipelineStepKind {
    return this.data.kind;
  }

  get laneId(): string {
    return this.data.laneId;
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

  get errorReturnToLaneId(): string | undefined {
    return this.data.errorReturnToLaneId;
  }

  /** The step's own label (agent kind, command label, or approval). */
  get label(): string {
    switch (this.kind) {
      case 'agent':
        return this.agentKind?.trim() || 'agent';
      case 'command':
        return this.description?.trim() || 'command';
      case 'human':
        return 'approval';
      case 'backlog':
        return this.description?.trim() || 'backlog';
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
      laneId: this.data.laneId,
      ...(this.data.agentKind ? { agentKind: this.data.agentKind } : {}),
      ...(this.data.instructions ? { instructions: this.data.instructions } : {}),
      ...(this.data.command ? { command: this.data.command } : {}),
      ...(this.data.description ? { description: this.data.description } : {}),
      ...(this.data.outcomes?.length
        ? { outcomes: this.data.outcomes.map((rule) => ({ ...rule })) }
        : {}),
      ...(this.data.requiresOutcome ? { requiresOutcome: true } : {}),
      ...(this.data.errorReturnToLaneId ? { errorReturnToLaneId: this.data.errorReturnToLaneId } : {}),
    };
  }

  /** What the step needs per kind — the server validates the same rule. */
  missingField(): string | null {
    switch (this.data.kind) {
      case 'agent':
        if (!this.data.agentKind?.trim()) return 'an agent step needs an agent';
        return null;
      case 'command':
        if (!this.data.command?.trim()) return 'a command step needs a command';
        return null;
      case 'human':
        if (!this.data.description?.trim()) return 'a human step needs a description (the approval prompt)';
        return null;
      case 'backlog':
        return null;
    }
  }
}

/** One board lane of a pipeline: a swimlane/column a card sits in. */
export class PipelineLane {
  constructor(
    readonly id: string,
    readonly label: string,
    readonly kanbanVisible: boolean,
    readonly terminal: boolean,
  ) {}

  static fromWire(json: PipelineLaneJson): PipelineLane {
    return new PipelineLane(
      json.id,
      json.label ?? '',
      json.kanbanVisible !== false,
      json.terminal === true,
    );
  }

  toWire(): PipelineLaneJson {
    return {
      id: this.id,
      label: this.label,
      kanbanVisible: this.kanbanVisible,
      ...(this.terminal ? { terminal: true } : {}),
    };
  }
}

export interface PipelineData {
  readonly id: string;
  readonly name: string;
  /** The editor's sidebar group (absent = the "General" group). */
  readonly category?: string;
  /** 1-based; the server allocates the next revision on a changed save. */
  readonly revision: number;
  /** The board's lanes (columns), in forward presentation order. */
  readonly lanes: readonly PipelineLane[];
  /** The ordered executable steps (index = forward execution order). */
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

  get category(): string | undefined {
    return this.data.category;
  }

  get revision(): number {
    return this.data.revision;
  }

  get lanes(): readonly PipelineLane[] {
    return this.data.lanes;
  }

  get steps(): readonly PipelineStep[] {
    return this.data.steps;
  }

  laneById(id: string): PipelineLane | undefined {
    return this.data.lanes.find((lane) => lane.id === id);
  }

  stepById(id: string): PipelineStep | undefined {
    return this.data.steps.find((step) => step.id === id);
  }

  /** The lane's forward presentation order (absent = -1). */
  laneOrder(id: string): number {
    return this.data.lanes.findIndex((lane) => lane.id === id);
  }

  /** The pipeline's first lane — a new or reopened card begins here. */
  get firstLaneId(): string {
    return this.data.lanes[0]?.id ?? '';
  }

  isTerminalLane(laneId: string): boolean {
    return this.data.lanes.find((lane) => lane.id === laneId)?.terminal === true;
  }

  get terminalLaneId(): string | undefined {
    return this.data.lanes.find((lane) => lane.terminal)?.id;
  }

  /** The board columns: the kanban-visible lanes, in forward order. */
  columns(): readonly PipelineLane[] {
    return this.data.lanes.filter((lane) => lane.kanbanVisible);
  }

  /** The lane's presentation label (falls back to the id). */
  laneLabel(laneId: string): string {
    return this.data.lanes.find((lane) => lane.id === laneId)?.label ?? laneId;
  }

  with(changes: Partial<PipelineData>): Pipeline {
    return new Pipeline({ ...this.data, ...changes });
  }

  toWire(): PipelineJson {
    return {
      id: this.data.id,
      projectId: '',
      name: this.data.name,
      ...(this.data.category ? { category: this.data.category } : {}),
      revision: this.data.revision,
      lanes: this.data.lanes.map((lane) => lane.toWire()),
      steps: this.data.steps.map((step) => step.toWire()),
      updatedAt: '',
    };
  }

  static fromWire(json: PipelineJson): Pipeline {
    return new Pipeline({
      id: json.id ?? '',
      name: json.name ?? '',
      ...(json.category ? { category: json.category } : {}),
      revision: json.revision ?? 1,
      lanes: (json.lanes ?? []).map((lane) => PipelineLane.fromWire(lane)),
      steps: (json.steps ?? []).map(
        (step) =>
          new PipelineStep({
            id: step.id ?? '',
            kind: step.kind ?? 'agent',
            laneId: step.laneId ?? '',
            ...(step.agentKind ? { agentKind: step.agentKind } : {}),
            ...(step.instructions ? { instructions: step.instructions } : {}),
            ...(step.command ? { command: step.command } : {}),
            ...(step.description ? { description: step.description } : {}),
            ...(step.outcomes?.length
              ? { outcomes: step.outcomes.map((rule) => ({ ...rule })) }
              : {}),
            ...(step.requiresOutcome ? { requiresOutcome: true } : {}),
            ...(step.errorReturnToLaneId ? { errorReturnToLaneId: step.errorReturnToLaneId } : {}),
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
  readonly routedToLaneId?: string;
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