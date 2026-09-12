// The pipeline editor's working copy (F1): a mutable-ish draft of one
// pipeline whose rules live here — conversion from/to the `Pipeline` model,
// live client validation (the server re-validates the same rule), step
// reordering (with the forward-path rules), and fresh id allocation. The
// editor component renders this and forwards edits; it holds no pipeline
// policy of its own.

import {
  Pipeline,
  PipelineLane,
  PipelineStep,
  PipelineStepKind,
} from '../core/models/pipeline.models';

export interface StepDraft {
  id: string;
  kind: PipelineStepKind;
  boardVisible: boolean;
  terminal: boolean;
  agentKind: string;
  instructions: string;
  command: string;
  description: string;
  outcomes: { outcome: string; toStepId: string }[];
  requiresOutcome: boolean;
  errorReturnToStepId: string;
}

export interface EditorDraftData {
  readonly projectId: string;
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly steps: readonly StepDraft[];
  readonly rejection: string | null;
}

export class EditorDraft {
  readonly projectId: string;
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly steps: readonly StepDraft[];
  readonly rejection: string | null;

  constructor(data: EditorDraftData) {
    this.projectId = data.projectId;
    this.id = data.id;
    this.name = data.name;
    this.category = data.category;
    this.steps = data.steps;
    this.rejection = data.rejection;
  }

  /** The default first draft (a coder swimlane plus the Done step). */
  static newDraft(projectId: string): EditorDraft {
    return new EditorDraft({
      projectId,
      id: '',
      name: '',
      category: '',
      steps: [coderDraft('st-1'), terminalDraft('st-2')],
      rejection: null,
    });
  }

  /** A draft editing an existing pipeline. */
  static fromPipeline(projectId: string, pipeline: Pipeline): EditorDraft {
    const steps = pipeline.steps.map((step) => stepDraftOf(step, pipeline));
    steps.push(terminalDraft('done'));
    return new EditorDraft({
      projectId,
      id: pipeline.id,
      name: pipeline.name,
      category: pipeline.category ?? '',
      steps,
      rejection: null,
    });
  }

  with(changes: Partial<EditorDraftData>): EditorDraft {
    return new EditorDraft({ ...this, ...changes });
  }

  withName(name: string): EditorDraft {
    return this.with({ name, rejection: null });
  }

  withCategory(category: string): EditorDraft {
    return this.with({ category, rejection: null });
  }

  // ---- Step mutations ----

  /** Adds a step ahead of the terminal one (a preset fills its fields). */
  addStep(preset?: Partial<Omit<StepDraft, 'id'>>): EditorDraft {
    const step: StepDraft = { ...coderDraft(nextStepId(this.steps)), ...preset };
    const terminalIndex = this.steps.findIndex((candidate) => candidate.terminal);
    const steps = [...this.steps];
    steps.splice(terminalIndex < 0 ? steps.length : terminalIndex, 0, step);
    return this.with({ steps, rejection: null });
  }

  /** Inserts a fresh step right after `afterIndex` (a preset fills its fields). */
  insertStep(afterIndex: number, preset?: Partial<Omit<StepDraft, 'id'>>): EditorDraft {
    const anchor = this.steps[afterIndex];
    if (anchor === undefined || anchor.terminal) return this;
    const steps = [...this.steps];
    steps.splice(afterIndex + 1, 0, { ...coderDraft(nextStepId(this.steps)), ...preset });
    return this.with({ steps, rejection: null });
  }

  /** Duplicates a step (new id) right after it; the terminal cannot be copied. */
  duplicateStep(index: number): EditorDraft {
    const source = this.steps[index];
    if (source === undefined || source.terminal) return this;
    const copy: StepDraft = {
      ...source,
      id: nextStepId(this.steps),
      outcomes: source.outcomes.map((rule) => ({ ...rule })),
    };
    const steps = [...this.steps];
    steps.splice(index + 1, 0, copy);
    return this.with({ steps, rejection: null });
  }

  /** Removes a step; the terminal step cannot be removed. */
  removeStep(index: number): EditorDraft {
    const removed = this.steps[index];
    if (removed === undefined) return this;
    if (removed.terminal) {
      return this.with({ rejection: 'The Done step must stay last — it cannot be removed' });
    }
    return this.with({ steps: this.steps.filter((_, i) => i !== index), rejection: null });
  }

  /**
   * Moves a step; the terminal step is pinned last and a swapped order that
   * would break the first-visible or backward-route rules records a
   * rejection instead of applying.
   */
  moveStep(index: number, delta: -1 | 1): EditorDraft {
    if (!this.canMoveStep(index, delta)) return this;
    const target = index + delta;
    const steps = [...this.steps];
    [steps[index], steps[target]] = [steps[target]!, steps[index]!];
    const error = stepOrderError(steps);
    if (error !== null) return this.with({ rejection: error });
    return this.with({ steps, rejection: null });
  }

  canMoveStep(index: number, delta: -1 | 1): boolean {
    const target = index + delta;
    if (target < 0 || target >= this.steps.length) return false;
    if (this.steps[index]?.terminal === true || this.steps[target]?.terminal === true) return false;
    return true;
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

  // ---- Step outcome rules (S36) ----

  addOutcome(stepIndex: number): EditorDraft {
    return this.updateStep(stepIndex, {
      outcomes: [...this.steps[stepIndex]!.outcomes, { outcome: '', toStepId: '' }],
    });
  }

  removeOutcome(stepIndex: number, ruleIndex: number): EditorDraft {
    const outcomes = this.steps[stepIndex]!.outcomes.filter((_, i) => i !== ruleIndex);
    return this.updateStep(stepIndex, {
      outcomes,
      ...(outcomes.length === 0 ? { requiresOutcome: false } : {}),
    });
  }

  updateOutcome(stepIndex: number, ruleIndex: number, patch: Partial<{ outcome: string; toStepId: string }>): EditorDraft {
    const outcomes = this.steps[stepIndex]!.outcomes.map((rule, i) =>
      i === ruleIndex ? { ...rule, ...patch } : rule,
    );
    return this.updateStep(stepIndex, { outcomes });
  }

  /** The lanes an error return or outcome rule may target: earlier board-visible steps (each is a lane). */
  errorTargets(index: number): StepDraft[] {
    return this.steps.slice(0, index).filter((step) => !step.terminal && step.boardVisible);
  }

  // ---- Validation + conversion ----

  /**
   * Client-side pre-validation (the server re-validates the same rule).
   * Defensive against non-string drafts: it runs inside the render loop, and
   * a throw here aborts change detection for the whole view.
   */
  validate(): string | null {
    const name = this.name;
    const steps = this.steps;

    if (text(name) === '') return 'Pipeline name is required';
    if (steps.length === 0) return 'A pipeline needs at least one step';

    const seen = new Set<string>();
    for (const [index, step] of steps.entries()) {
      const id = text(step.id);
      if (id === '') return `Step ${index + 1} needs an id`;
      if (seen.has(id)) return `Step id '${id}' appears twice`;
      seen.add(id);
    }

    for (const [index, step] of steps.entries()) {
      const label = `Step ${index + 1}`;
      const id = text(step.id);
      const target = text(step.errorReturnToStepId);
      if (target !== '') {
        const targetIndex = steps.findIndex((candidate) => candidate.id === target);
        if (targetIndex < 0) return `${label}: the error condition names an unknown step`;
        if (targetIndex >= index) return `${label}: the error condition may only return to an earlier step`;
      }
      const names = new Set<string>();
      for (const [ruleIndex, rule] of step.outcomes.entries()) {
        const outcomeName = text(rule.outcome).trim();
        if (outcomeName === '') return `${label}: outcome ${ruleIndex + 1} needs a name`;
        if (names.has(outcomeName)) return `${label}: outcome '${outcomeName}' appears twice`;
        names.add(outcomeName);
        const targetId = text(rule.toStepId);
        if (targetId === '') continue;
        const targetIndex = steps.findIndex((candidate) => candidate.id === targetId);
        if (targetIndex < 0 || targetIndex >= index) {
          return `${label}: outcome '${outcomeName}' may only return to an earlier step`;
        }
      }
      if (!step.terminal) {
        const missing = new PipelineStep({
          id,
          kind: step.kind,
          laneId: '',
          ...(text(step.agentKind) ? { agentKind: text(step.agentKind) } : {}),
          ...(text(step.instructions) ? { instructions: text(step.instructions) } : {}),
          ...(text(step.command) ? { command: text(step.command) } : {}),
          ...(text(step.description) ? { description: text(step.description) } : {}),
        }).missingField();
        if (missing !== null) return `${label}: ${missing}`;
      }
    }

    const terminals = steps.filter((step) => step.terminal);
    if (terminals.length !== 1) return 'A pipeline needs exactly one terminal (Done) step';
    if (!steps.some((step) => !step.terminal)) return 'A pipeline needs at least one non-terminal executable step';
    if (steps.at(-1)?.terminal !== true) return 'The terminal step must be the last step';
    if (steps[0]?.boardVisible !== true) return 'The first step must be board-visible';
    return null;
  }

  /** The `Pipeline` model a save publishes (trimmed; lanes derived from the draft's swimlanes). */
  toPipeline(): Pipeline {
    // A board-visible step starts a new lane; hidden steps share the lane.
    const stepLane = new Map<string, string>();
    const lanes: PipelineLane[] = [];
    let counter = 0;
    for (const step of this.steps) {
      if (step.terminal) continue;
      if (step.boardVisible || lanes.length === 0) {
        counter += 1;
        stepLane.set(step.id, `ln-${counter}`);
        lanes.push(new PipelineLane(`ln-${counter}`, laneLabelOf(step), true, false));
      } else {
        stepLane.set(step.id, `ln-${counter}`);
      }
    }
    counter += 1;
    const terminal = this.steps.find((step) => step.terminal);
    lanes.push(new PipelineLane(`ln-${counter}`, text(terminal?.description).trim() || 'done', true, true));

    const steps = this.steps
      .filter((step) => !step.terminal)
      .map((step) => {
        const outcomes = step.outcomes
          .map((rule) => ({ outcome: text(rule.outcome).trim(), toLaneId: text(rule.toStepId).trim() }))
          .filter((rule) => rule.outcome !== '')
          .map((rule) =>
            rule.toLaneId !== '' ? { outcome: rule.outcome, toLaneId: stepLane.get(rule.toLaneId) ?? rule.toLaneId } : { outcome: rule.outcome },
          );
        return new PipelineStep({
          id: text(step.id).trim(),
          kind: step.kind,
          laneId: stepLane.get(step.id) ?? '',
          ...(text(step.agentKind).trim() ? { agentKind: text(step.agentKind).trim() } : {}),
          ...(text(step.instructions).trim() ? { instructions: text(step.instructions).trim() } : {}),
          ...(text(step.command).trim() ? { command: text(step.command).trim() } : {}),
          ...(text(step.description).trim() ? { description: text(step.description).trim() } : {}),
          ...(outcomes.length > 0 ? { outcomes } : {}),
          ...(outcomes.length > 0 && step.requiresOutcome ? { requiresOutcome: true } : {}),
          ...(text(step.errorReturnToStepId).trim() !== ''
            ? { errorReturnToLaneId: stepLane.get(text(step.errorReturnToStepId).trim()) ?? '' }
            : {}),
        });
      });

    return new Pipeline({
      id: this.id,
      name: text(this.name).trim(),
      ...(text(this.category).trim() !== '' ? { category: text(this.category).trim() } : {}),
      revision: 0,
      lanes,
      steps,
    });
  }
}

function stepDraftOf(step: PipelineStep, pipeline: Pipeline): StepDraft {
  const firstOfLane = pipeline.steps.find((s) => s.laneId === step.laneId)?.id === step.id;
  const stepForLane = (laneId: string | undefined): string =>
    laneId !== undefined ? (pipeline.steps.find((s) => s.laneId === laneId)?.id ?? '') : '';
  return {
    id: step.id,
    kind: step.kind,
    boardVisible: firstOfLane,
    terminal: false,
    agentKind: step.agentKind ?? '',
    instructions: step.instructions ?? '',
    command: step.command ?? '',
    description: step.description ?? '',
    outcomes: step.outcomes.map((rule) => ({
      outcome: rule.outcome,
      toStepId: stepForLane(rule.toLaneId),
    })),
    requiresOutcome: step.requiresOutcome,
    errorReturnToStepId: stepForLane(step.errorReturnToLaneId),
  };
}

/** The lane label derived from the first step of the lane. */
function laneLabelOf(step: StepDraft): string {
  switch (step.kind) {
    case 'agent':
      return step.agentKind.trim() || 'agent';
    case 'command':
      return step.description.trim() || 'command';
    case 'human':
      return 'approval';
    case 'backlog':
      return step.description.trim() || 'backlog';
  }
}

/** A fresh coder swimlane step (the editor's default for "+ add step"). */
function coderDraft(id: string): StepDraft {
  return {
    id,
    kind: 'agent',
    boardVisible: true,
    terminal: false,
    agentKind: 'coder',
    instructions: '',
    command: '',
    description: '',
    outcomes: [],
    requiresOutcome: false,
    errorReturnToStepId: '',
  };
}

/** The pipeline's terminal Done step (a pure swimlane marker). */
function terminalDraft(id: string): StepDraft {
  return {
    id,
    kind: 'human',
    boardVisible: true,
    terminal: true,
    agentKind: '',
    instructions: '',
    command: '',
    description: '',
    outcomes: [],
    requiresOutcome: false,
    errorReturnToStepId: '',
  };
}

function nextStepId(steps: readonly StepDraft[]): string {
  let max = 0;
  for (const step of steps) {
    const match = /^st-(\d+)$/.exec(step.id);
    if (match?.[1] !== undefined) max = Math.max(max, Number(match[1]));
  }
  return `st-${max + 1}`;
}

/** The backward-route and terminal/visibility rules a reorder must preserve. */
function stepOrderError(steps: readonly StepDraft[]): string | null {
  if (steps.at(-1)?.terminal !== true) return 'The Done step must stay last';
  if (steps[0]?.boardVisible !== true) return 'The first step must remain board-visible';
  for (const [index, step] of steps.entries()) {
    const targets = [
      step.errorReturnToStepId,
      ...step.outcomes.map((outcome) => outcome.toStepId),
    ].filter(Boolean);
    for (const target of targets) {
      if (steps.findIndex((candidate) => candidate.id === target) >= index) {
        return `Clear the backward route from step ${index + 1} before moving it`;
      }
    }
  }
  return null;
}

/** Coerce an editable field to text (validate runs in the render path). */
function text(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}
