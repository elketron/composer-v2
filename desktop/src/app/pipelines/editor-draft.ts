// The pipeline editor's working copy (F1): a mutable-ish draft of one
// pipeline whose rules live here — conversion from/to the `Pipeline` model,
// live client validation (the server re-validates the same rule), stage/step
// reordering (with the forward-path regroup), and fresh id allocation. The
// editor component renders this and forwards edits; it holds no pipeline
// policy of its own.

import {
  Pipeline,
  PipelineStage,
  PipelineStep,
  PipelineStepKind,
} from '../core/models/pipeline.models';

export interface StageDraft {
  id: string;
  label: string;
  kanbanVisible: boolean;
  terminal: boolean;
  errorReturnToStageId: string;
  outcomes: { outcome: string; toStageId: string }[];
  requiresOutcome: boolean;
}

export interface StepDraft {
  id: string;
  kind: PipelineStepKind;
  stageId: string;
  agentKind: string;
  instructions: string;
  command: string;
  description: string;
}

export interface EditorDraftData {
  readonly id: string;
  readonly name: string;
  readonly stages: readonly StageDraft[];
  readonly steps: readonly StepDraft[];
  readonly rejection: string | null;
}

export class EditorDraft {
  readonly id: string;
  readonly name: string;
  readonly stages: readonly StageDraft[];
  readonly steps: readonly StepDraft[];
  readonly rejection: string | null;

  constructor(data: EditorDraftData) {
    this.id = data.id;
    this.name = data.name;
    this.stages = data.stages;
    this.steps = data.steps;
    this.rejection = data.rejection;
  }

  /** The default first draft (a two-stage, one-step skeleton). */
  static newDraft(): EditorDraft {
    const stages: StageDraft[] = [
      { id: 'sg-1', label: 'In progress', kanbanVisible: true, terminal: false, errorReturnToStageId: '', outcomes: [], requiresOutcome: false },
      { id: 'sg-2', label: 'Done', kanbanVisible: true, terminal: true, errorReturnToStageId: '', outcomes: [], requiresOutcome: false },
    ];
    return new EditorDraft({
      id: '',
      name: '',
      stages,
      steps: [{ id: 'st-1', kind: 'agent', stageId: 'sg-1', agentKind: 'coder', instructions: '', command: '', description: '' }],
      rejection: null,
    });
  }

  /** A draft editing an existing pipeline. */
  static fromPipeline(pipeline: Pipeline): EditorDraft {
    return new EditorDraft({
      id: pipeline.id,
      name: pipeline.name,
      stages: pipeline.stages.map(stageDraftOf),
      steps: pipeline.steps.map(stepDraftOf),
      rejection: null,
    });
  }

  /** The first stage id (the selection default). */
  firstStageId(): string | null {
    return this.stages[0]?.id ?? null;
  }

  with(changes: Partial<EditorDraftData>): EditorDraft {
    return new EditorDraft({ ...this, ...changes });
  }

  // ---- Name / rejection ----

  withName(name: string): EditorDraft {
    return this.with({ name, rejection: null });
  }

  // ---- Stage mutations ----

  /** Adds a stage ahead of the terminal one; returns the fresh id to select. */
  addStage(): { draft: EditorDraft; stageId: string } {
    const next = nextStageId(this.stages);
    const terminal = this.stages.at(-1);
    const fresh: StageDraft = { id: next, label: '', kanbanVisible: true, terminal: false, errorReturnToStageId: '', outcomes: [], requiresOutcome: false };
    const stages = terminal !== undefined && terminal.terminal
      ? [...this.stages.slice(0, -1), fresh, terminal]
      : [...this.stages, fresh];
    return { draft: this.with({ stages, rejection: null }), stageId: next };
  }

  /** Removes a stage, or records a rejection when steps/backward routes reference it. */
  removeStage(index: number): EditorDraft {
    const removed = this.stages[index];
    if (removed === undefined) return this;
    const linkedSteps = this.steps.filter((step) => step.stageId === removed.id).length;
    if (linkedSteps > 0) {
      return this.with({
        rejection: `Move the ${linkedSteps} step${linkedSteps === 1 ? '' : 's'} assigned to ${removed.label || removed.id} before removing this stage`,
      });
    }
    const referenced = this.stages.some(
      (stage) =>
        stage.errorReturnToStageId === removed.id ||
        stage.outcomes.some((outcome) => outcome.toStageId === removed.id),
    );
    if (referenced) {
      return this.with({ rejection: `Clear routes returning to ${removed.label || removed.id} before removing this stage` });
    }
    return this.with({ stages: this.stages.filter((_, i) => i !== index), rejection: null });
  }

  /**
   * Moves a stage, regrouping the flat step list to preserve order within
   * each stage (a simple stage move cannot create a backward execution path).
   */
  moveStage(index: number, delta: -1 | 1): EditorDraft {
    const target = index + delta;
    if (target < 0 || target >= this.stages.length) return this;
    const stages = [...this.stages];
    [stages[index], stages[target]] = [stages[target]!, stages[index]!];
    const structuralError = stageOrderError(stages);
    if (structuralError !== null) {
      return this.with({ rejection: structuralError });
    }
    const order = new Map(stages.map((stage, stageIndex) => [stage.id, stageIndex]));
    const steps = this.steps
      .map((step, stepIndex) => ({ step, stepIndex }))
      .sort((left, right) =>
        (order.get(left.step.stageId) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(right.step.stageId) ?? Number.MAX_SAFE_INTEGER) ||
        left.stepIndex - right.stepIndex,
      )
      .map(({ step }) => step);
    return this.with({ stages, steps, rejection: null });
  }

  canMoveStage(index: number, delta: -1 | 1): boolean {
    const target = index + delta;
    if (target < 0 || target >= this.stages.length) return false;
    const stages = [...this.stages];
    [stages[index], stages[target]] = [stages[target]!, stages[index]!];
    return stageOrderError(stages) === null;
  }

  updateStage(index: number, patch: Partial<StageDraft>): EditorDraft {
    return this.with({
      stages: this.stages.map((stage, i) => (i === index ? { ...stage, ...patch } : stage)),
      rejection: null,
    });
  }

  addOutcome(stageIndex: number): EditorDraft {
    return this.updateStage(stageIndex, {
      outcomes: [...this.stages[stageIndex]!.outcomes, { outcome: '', toStageId: '' }],
    });
  }

  removeOutcome(stageIndex: number, ruleIndex: number): EditorDraft {
    const outcomes = this.stages[stageIndex]!.outcomes.filter((_, i) => i !== ruleIndex);
    return this.updateStage(stageIndex, {
      outcomes,
      ...(outcomes.length === 0 ? { requiresOutcome: false } : {}),
    });
  }

  updateOutcome(stageIndex: number, ruleIndex: number, patch: Partial<{ outcome: string; toStageId: string }>): EditorDraft {
    const outcomes = this.stages[stageIndex]!.outcomes.map((rule, i) =>
      i === ruleIndex ? { ...rule, ...patch } : rule,
    );
    return this.updateStage(stageIndex, { outcomes });
  }

  /** The stages an error return or outcome rule may target: strictly earlier ones. */
  errorTargets(index: number): StageDraft[] {
    return this.stages.slice(0, index);
  }

  // ---- Step mutations ----

  addStep(): EditorDraft {
    const stage = this.stages.find((candidate) => !candidate.terminal) ?? this.stages[0];
    if (stage === undefined) return this;
    const step: StepDraft = {
      id: nextStepId(this.steps),
      kind: 'command',
      stageId: stage.id,
      agentKind: 'coder',
      instructions: '',
      command: '',
      description: '',
    };
    const steps = [...this.steps];
    steps.splice(insertPositionFor(this.stages, this.steps, stage.id), 0, step);
    return this.with({ steps, rejection: null });
  }

  removeStep(index: number): EditorDraft {
    return this.with({ steps: this.steps.filter((_, i) => i !== index), rejection: null });
  }

  moveStep(index: number, delta: -1 | 1): EditorDraft {
    if (!this.canMoveStep(index, delta)) return this;
    const target = index + delta;
    const steps = [...this.steps];
    [steps[index], steps[target]] = [steps[target]!, steps[index]!];
    return this.with({ steps, rejection: null });
  }

  canMoveStep(index: number, delta: -1 | 1): boolean {
    const target = index + delta;
    return target >= 0 && target < this.steps.length && this.steps[index]?.stageId === this.steps[target]?.stageId;
  }

  /** Changing stage also moves the step into that stage's contiguous run region. */
  assignStepToStage(index: number, stageId: string): EditorDraft {
    const step = this.steps[index];
    if (step === undefined || step.stageId === stageId) return this;
    const without = this.steps.filter((_, stepIndex) => stepIndex !== index);
    const moved = { ...step, stageId };
    without.splice(insertPositionFor(this.stages, without, stageId), 0, moved);
    return this.with({ steps: without, rejection: null });
  }

  updateStepKind(index: number, kind: PipelineStepKind): EditorDraft {
    return this.updateStep(index, {
      kind,
      agentKind: kind === 'agent' ? 'coder' : '',
      instructions: '',
      command: '',
      description: '',
    });
  }

  updateStep(index: number, patch: Partial<StepDraft>): EditorDraft {
    return this.with({
      steps: this.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)),
      rejection: null,
    });
  }

  // ---- Validation + conversion ----

  /**
   * Client-side pre-validation (the server re-validates the same rule).
   * Defensive against non-string drafts: it runs inside the render loop, and
   * a throw here aborts change detection for the whole view.
   */
  validate(): string | null {
    const name = this.name;
    const stages = this.stages;
    const steps = this.steps;

    const nameText = text(name);
    if (nameText === '') return 'Pipeline name is required';
    if (stages.length === 0) return 'A pipeline needs at least one stage';
    if (steps.length === 0) return 'A pipeline needs at least one step';

    const seenStages = new Set<string>();
    for (const [index, stage] of stages.entries()) {
      const id = text(stage.id);
      if (id === '') return `Stage ${index + 1} needs an id`;
      if (seenStages.has(id)) return `Stage id '${id}' appears twice`;
      if (text(stage.label).trim() === '') return `Stage ${index + 1} needs a label`;
      seenStages.add(id);
    }
    const terminals = stages.filter((stage) => stage.terminal);
    if (terminals.length !== 1) return 'A pipeline needs exactly one terminal (Done) stage';
    if (stages.at(-1)?.terminal !== true) return 'The terminal stage must be the last stage';
    if (stages[0]?.kanbanVisible !== true) return 'The first stage must be Kanban-visible';
    for (const [index, stage] of stages.entries()) {
      const target = text(stage.errorReturnToStageId);
      if (target === '') continue;
      const targetIndex = stages.findIndex((candidate) => candidate.id === target);
      if (targetIndex < 0) return `Stage ${index + 1}: the error condition names an unknown stage`;
      if (targetIndex >= index) return `Stage ${index + 1}: the error condition may only return to an earlier stage`;
    }
    for (const [index, stage] of stages.entries()) {
      const names = new Set<string>();
      for (const [ruleIndex, rule] of stage.outcomes.entries()) {
        const name = text(rule.outcome).trim();
        if (name === '') return `Stage ${index + 1}: outcome ${ruleIndex + 1} needs a name`;
        if (names.has(name)) return `Stage ${index + 1}: outcome '${name}' appears twice`;
        names.add(name);
        const target = text(rule.toStageId);
        if (target === '') continue;
        const targetIndex = stages.findIndex((candidate) => candidate.id === target);
        if (targetIndex < 0 || targetIndex >= index) {
          return `Stage ${index + 1}: outcome '${name}' may only return to an earlier stage`;
        }
      }
    }

    const seenSteps = new Set<string>();
    let lastOrder = -1;
    for (const [index, step] of steps.entries()) {
      const id = text(step.id);
      if (id === '') return `Step ${index + 1} needs an id`;
      if (seenSteps.has(id)) return `Step id '${id}' appears twice`;
      seenSteps.add(id);
      const stageIndex = stages.findIndex((stage) => stage.id === step.stageId);
      if (stageIndex < 0) return `Step ${index + 1}: stage '${step.stageId}' is not a stage of this pipeline`;
      if (stageIndex < lastOrder) return `Step ${index + 1}: the normal path must not move to an earlier stage`;
      lastOrder = stageIndex;
      const missing = new PipelineStep({
        id,
        kind: step.kind,
        stageId: step.stageId,
        ...(text(step.agentKind) ? { agentKind: text(step.agentKind) } : {}),
        ...(text(step.instructions) ? { instructions: text(step.instructions) } : {}),
        ...(text(step.command) ? { command: text(step.command) } : {}),
        ...(text(step.description) ? { description: text(step.description) } : {}),
      }).missingField();
      if (missing !== null) return `Step ${index + 1}: ${missing}`;
    }
    return null;
  }

  /** The `Pipeline` model a save publishes (trimmed, wire-shaped). */
  toPipeline(): Pipeline {
    return new Pipeline({
      id: this.id,
      name: text(this.name).trim(),
      revision: 0,
      stages: this.stages.map((stage) => {
        const outcomes = stage.outcomes
          .map((rule) => ({ outcome: text(rule.outcome).trim(), toStageId: text(rule.toStageId).trim() }))
          .filter((rule) => rule.outcome !== '')
          .map((rule) => (rule.toStageId !== '' ? rule : { outcome: rule.outcome }));
        return new PipelineStage({
          id: text(stage.id).trim(),
          label: text(stage.label).trim(),
          kanbanVisible: stage.kanbanVisible,
          ...(stage.terminal ? { terminal: true } : {}),
          ...(outcomes.length > 0 ? { outcomes } : {}),
          ...(outcomes.length > 0 && stage.requiresOutcome ? { requiresOutcome: true } : {}),
          ...(text(stage.errorReturnToStageId).trim() !== ''
            ? { errorReturnToStageId: text(stage.errorReturnToStageId).trim() }
            : {}),
        });
      }),
      steps: this.steps.map((step) =>
        new PipelineStep({
          id: text(step.id).trim(),
          kind: step.kind,
          stageId: step.stageId,
          ...(text(step.agentKind).trim() ? { agentKind: text(step.agentKind).trim() } : {}),
          ...(text(step.instructions).trim() ? { instructions: text(step.instructions).trim() } : {}),
          ...(text(step.command).trim() ? { command: text(step.command).trim() } : {}),
          ...(text(step.description).trim() ? { description: text(step.description).trim() } : {}),
        }),
      ),
    });
  }
}

function stageDraftOf(stage: PipelineStage): StageDraft {
  return {
    id: stage.id,
    label: stage.label,
    kanbanVisible: stage.kanbanVisible,
    terminal: stage.terminal,
    errorReturnToStageId: stage.errorReturnToStageId ?? '',
    outcomes: (stage.data.outcomes ?? []).map((rule) => ({ outcome: rule.outcome, toStageId: rule.toStageId ?? '' })),
    requiresOutcome: stage.data.requiresOutcome === true,
  };
}

function stepDraftOf(step: PipelineStep): StepDraft {
  return {
    id: step.id,
    kind: step.kind,
    stageId: step.stageId,
    agentKind: step.agentKind ?? '',
    instructions: step.instructions ?? '',
    command: step.command ?? '',
    description: step.description ?? '',
  };
}

function nextStageId(stages: readonly StageDraft[]): string {
  let max = 0;
  for (const stage of stages) {
    const match = /^sg-(\d+)$/.exec(stage.id);
    if (match?.[1] !== undefined) max = Math.max(max, Number(match[1]));
  }
  return `sg-${max + 1}`;
}

function nextStepId(steps: readonly StepDraft[]): string {
  let max = 0;
  for (const step of steps) {
    const match = /^st-(\d+)$/.exec(step.id);
    if (match?.[1] !== undefined) max = Math.max(max, Number(match[1]));
  }
  return `st-${max + 1}`;
}

function stageOrderError(stages: readonly StageDraft[]): string | null {
  if (stages.filter((stage) => stage.terminal).length !== 1 || stages.at(-1)?.terminal !== true) {
    return 'The Done stage must stay last';
  }
  if (stages[0]?.kanbanVisible !== true) return 'The first stage must remain a visible column';
  for (const [index, stage] of stages.entries()) {
    const targets = [
      stage.errorReturnToStageId,
      ...stage.outcomes.map((outcome) => outcome.toStageId),
    ].filter(Boolean);
    if (
      targets.some(
        (target) => stages.findIndex((candidate) => candidate.id === target) >= index,
      )
    ) {
      return `Move or clear the backward routes on ${stage.label || stage.id} first`;
    }
  }
  return null;
}

/**
 * Where a new step for `stageId` joins the flat list: after the stage's
 * last step, or before the first step of a later stage — so the step lands
 * in the stage's run region (the forward path stays non-decreasing).
 */
function insertPositionFor(
  stages: readonly StageDraft[],
  steps: readonly StepDraft[],
  stageId: string,
): number {
  let last = -1;
  for (let i = 0; i < steps.length; i++) {
    if (steps[i]!.stageId === stageId) last = i;
  }
  if (last >= 0) return last + 1;
  const order = stages.findIndex((stage) => stage.id === stageId);
  for (let i = 0; i < steps.length; i++) {
    const stepOrder = stages.findIndex((stage) => stage.id === steps[i]!.stageId);
    if (stepOrder > order) return i;
  }
  return steps.length;
}

/** Coerce an editable field to text (validate runs in the render path). */
function text(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}