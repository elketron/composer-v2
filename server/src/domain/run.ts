// One pipeline run (dual identity, no wire twin — runs ride the log as
// started/ended events and the fold re-materializes them here): an immutable
// attempt pinned to the pipeline revision it started on; active runs also
// carry their current position. The fold replaces instances with `with()`
// as run events land.

import type { PipelineRunStatus, PipelineStepKind } from '../wire/models.js';

/** What constructs a run: the fields of one run record. */
export interface RunInit {
  id: string;
  cardId: string;
  pipelineId: string;
  revision: number;
  status: PipelineRunStatus;
  startedAt: string;
  endedAt?: string;
  error?: string;
  outcome?: string;
  feedback?: string;
  routedToStepId?: string;
  stepId?: string;
  stepKind?: PipelineStepKind;
}

export class Run {
  readonly id: string;
  readonly cardId: string;
  readonly pipelineId: string;
  readonly revision: number;
  readonly status: PipelineRunStatus;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly error?: string;
  readonly outcome?: string;
  readonly feedback?: string;
  readonly routedToStepId?: string;
  readonly stepId?: string;
  readonly stepKind?: PipelineStepKind;

  constructor(init: RunInit) {
    this.id = init.id;
    this.cardId = init.cardId;
    this.pipelineId = init.pipelineId;
    this.revision = init.revision;
    this.status = init.status;
    this.startedAt = init.startedAt;
    if (init.endedAt !== undefined) this.endedAt = init.endedAt;
    if (init.error !== undefined) this.error = init.error;
    if (init.outcome !== undefined) this.outcome = init.outcome;
    if (init.feedback !== undefined) this.feedback = init.feedback;
    if (init.routedToStepId !== undefined) this.routedToStepId = init.routedToStepId;
    if (init.stepId !== undefined) this.stepId = init.stepId;
    if (init.stepKind !== undefined) this.stepKind = init.stepKind;
  }

  /** Running, or parked waiting at an approval gate — the states boot cancels and archive refuses. */
  get isActive(): boolean {
    return this.status === 'running' || this.status === 'waiting';
  }

  /**
   * Copy with changes applied; a change set to undefined drops the field
   * (a run's position clears when the run ends).
   */
  with(changes: Partial<RunInit>): Run {
    const merged: Record<string, unknown> = { ...this.toInit() };
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete merged[key];
      else merged[key] = value;
    }
    return new Run(merged as unknown as RunInit);
  }

  private toInit(): RunInit {
    return {
      id: this.id,
      cardId: this.cardId,
      pipelineId: this.pipelineId,
      revision: this.revision,
      status: this.status,
      startedAt: this.startedAt,
      ...(this.endedAt !== undefined ? { endedAt: this.endedAt } : {}),
      ...(this.error !== undefined ? { error: this.error } : {}),
      ...(this.outcome !== undefined ? { outcome: this.outcome } : {}),
      ...(this.feedback !== undefined ? { feedback: this.feedback } : {}),
      ...(this.routedToStepId !== undefined ? { routedToStepId: this.routedToStepId } : {}),
      ...(this.stepId !== undefined ? { stepId: this.stepId } : {}),
      ...(this.stepKind !== undefined ? { stepKind: this.stepKind } : {}),
    };
  }
}
