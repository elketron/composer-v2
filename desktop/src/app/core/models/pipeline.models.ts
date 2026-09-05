import {
  PipelineJson,
  PipelineStepJson,
  WirePipelineRunStatus,
  WirePipelineStepKind,
} from '../events/wire';

/** The kind of work one pipeline step does (v1 M3, D7). */
export type PipelineStepKind = WirePipelineStepKind;

/** The state of a card's pipeline run (S3). */
export type PipelineRunStatus = WirePipelineRunStatus;

export interface PipelineStepData {
  readonly id: string;
  readonly kind: PipelineStepKind;
  readonly agentKind?: string;
  readonly instructions?: string;
  readonly command?: string;
  readonly description?: string;
  readonly retries?: number;
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
    const { id, kind } = this.data;
    return {
      id,
      kind,
      ...(this.data.agentKind ? { agentKind: this.data.agentKind } : {}),
      ...(this.data.instructions ? { instructions: this.data.instructions } : {}),
      ...(this.data.command ? { command: this.data.command } : {}),
      ...(this.data.description ? { description: this.data.description } : {}),
      ...(this.data.retries !== undefined ? { retries: this.data.retries } : {}),
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

  static empty(id: string, kind: PipelineStepKind): PipelineStep {
    return new PipelineStep({ id, kind });
  }
}

export interface PipelineData {
  readonly id: string;
  readonly name: string;
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

  get steps(): readonly PipelineStep[] {
    return this.data.steps;
  }

  stepById(id: string): PipelineStep | undefined {
    return this.data.steps.find((step) => step.id === id);
  }

  with(changes: Partial<PipelineData>): Pipeline {
    return new Pipeline({ ...this.data, ...changes });
  }

  toWire(): PipelineJson {
    return {
      id: this.data.id,
      projectId: '',
      name: this.data.name,
      steps: this.data.steps.map((step) => step.toWire()),
      updatedAt: '',
    };
  }

  static fromWire(json: PipelineJson): Pipeline {
    return new Pipeline({
      id: json.id ?? '',
      name: json.name ?? '',
      steps: (json.steps ?? []).map(
        (step) =>
          new PipelineStep({
            id: step.id ?? '',
            kind: step.kind ?? 'agent',
            ...(step.agentKind ? { agentKind: step.agentKind } : {}),
            ...(step.instructions ? { instructions: step.instructions } : {}),
            ...(step.command ? { command: step.command } : {}),
            ...(step.description ? { description: step.description } : {}),
            ...(step.retries !== undefined ? { retries: step.retries } : {}),
          }),
      ),
    });
  }
}

/** Where a card's pipeline run is (keyed by card id, one per card). */
export interface RunProgress {
  readonly pipelineId: string;
  readonly status: 'running' | 'waiting';
  readonly stepId?: string;
  readonly stepKind?: PipelineStepKind;
}
