import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';
import { ArrowDown, ArrowUp, Plus, Save, Trash2, Workflow, X } from 'lucide-angular';

import { ShellService } from '../shell/shell.service';
import { ConfirmService } from '../core/confirm/confirm.service';
import { SettingsService } from '../settings/settings.service';
import {
  Pipeline,
  PipelineStage,
  PipelineStep,
  PipelineStepKind,
} from '../core/models/pipeline.models';
import { PipelineService } from './pipeline.service';

interface StageDraft {
  id: string;
  label: string;
  kanbanVisible: boolean;
  terminal: boolean;
  errorReturnToStageId: string;
  outcomes: { outcome: string; toStageId: string }[];
  requiresOutcome: boolean;
}

interface StepDraft {
  id: string;
  kind: PipelineStepKind;
  stageId: string;
  agentKind: string;
  instructions: string;
  command: string;
  description: string;
}

/** The pipeline editor's working copy (a mutable draft of one pipeline). */
interface EditorDraft {
  id: string;
  name: string;
  stages: StageDraft[];
  steps: StepDraft[];
  rejection: string | null;
}

/**
 * The pipeline editor (S4, staged in Phase 10; the linear visual editor in
 * S37). Pipelines are user-authored (the ownership rule): the view lists
 * the project's pipelines and authors them from scratch — a name, the
 * compact stage path and a flat ordered step list with explicit stage
 * assignment. Save publishes requestPipelineSave (the server allocates fresh ids
 * and revisions, upserts known ones, and re-validates); deletions
 * tombstone the default.
 */
@Component({
  selector: 'app-pipeline-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, FormsModule],
  templateUrl: './pipeline-editor.component.html',
  styleUrl: './pipeline-editor.component.scss',
})
export class PipelineEditorComponent {
  private readonly shell = inject(ShellService);
  private readonly pipelines = inject(PipelineService);
  private readonly settings = inject(SettingsService);
  private readonly confirm = inject(ConfirmService);

  protected readonly projectId = computed(() => this.shell.activeTabId());
  protected readonly list = computed(() => this.pipelines.pipelines());

  /** The agent kinds the picker offers: the shipped ones plus overrides. */
  protected readonly agentKinds = this.settings.agentKinds;

  protected readonly kinds: readonly PipelineStepKind[] = ['agent', 'command', 'human'];

  /** The working copy being authored; null shows the list. */
  protected readonly editing = signal<EditorDraft | null>(null);

  /** The stage whose less-common routing settings are open. */
  protected readonly selectedStageId = signal<string | null>(null);

  protected readonly selectedStageIndex = computed(() => {
    const current = this.selectedStageId();
    const draft = this.editing();
    if (current === null || draft === null) return null;
    const index = draft.stages.findIndex((stage) => stage.id === current);
    return index < 0 ? null : index;
  });

  protected readonly selectedStageDraft = computed<StageDraft | null>(() => {
    const current = this.editing();
    const index = this.selectedStageIndex();
    return current !== null && index !== null ? (current.stages[index] ?? null) : null;
  });

  /** Client-side validation runs live, but only surfaces after a save attempt. */
  private readonly attemptedSave = signal(false);

  protected readonly validationError = computed(() => {
    const draft = this.editing();
    return draft ? this.validate(draft.name, draft.stages, draft.steps) : null;
  });

  protected readonly showError = computed(() => this.attemptedSave() && this.validationError() !== null);

  protected readonly icons = { workflow: Workflow, plus: Plus, trash: Trash2, save: Save, close: X, up: ArrowUp, down: ArrowDown };

  protected stepSummary(pipeline: Pipeline): string {
    return pipeline.steps.map((step) => this.kindLabel(step.kind)).join(' → ');
  }

  protected stageSummary(pipeline: Pipeline): string {
    return pipeline.stages.map((stage) => stage.label + (stage.terminal ? ' ✓' : stage.kanbanVisible ? '' : ' ·')).join(' → ');
  }

  protected kindLabel(kind: PipelineStepKind): string {
    switch (kind) {
      case 'agent':
        return 'agent';
      case 'command':
        return 'command';
      case 'human':
        return 'gate';
    }
  }

  protected canEdit(): boolean {
    return this.projectId() !== null;
  }

  protected newPipeline(): void {
    if (!this.canEdit()) return;
    this.attemptedSave.set(false);
    const stages: StageDraft[] = [
      { id: 'sg-1', label: 'In progress', kanbanVisible: true, terminal: false, errorReturnToStageId: '', outcomes: [], requiresOutcome: false },
      { id: 'sg-2', label: 'Done', kanbanVisible: true, terminal: true, errorReturnToStageId: '', outcomes: [], requiresOutcome: false },
    ];
    this.editing.set({
      id: '',
      name: '',
      stages,
      steps: [{ id: 'st-1', kind: 'agent', stageId: 'sg-1', agentKind: 'coder', instructions: '', command: '', description: '' }],
      rejection: null,
    });
    this.selectedStageId.set(stages[0]!.id);
  }

  protected edit(pipeline: Pipeline): void {
    if (!this.canEdit()) return;
    this.attemptedSave.set(false);
    this.editing.set({
      id: pipeline.id,
      name: pipeline.name,
      stages: pipeline.stages.map((stage) => this.stageDraftOf(stage)),
      steps: pipeline.steps.map((step) => this.draftOf(step)),
      rejection: null,
    });
    this.selectedStageId.set(pipeline.stages[0]?.id ?? null);
  }

  protected cancel(): void {
    this.attemptedSave.set(false);
    this.editing.set(null);
    this.selectedStageId.set(null);
  }

  protected updateName(name: string): void {
    this.patchDraft({ name, rejection: null });
  }

  protected selectStage(index: number): void {
    this.selectedStageId.set(this.editing()?.stages[index]?.id ?? null);
  }

  // ---- Stage mutations ----

  protected addStage(): void {
    const current = this.editing();
    if (current === null) return;
    const next = this.nextStageId(current.stages);
    const terminal = current.stages.at(-1);
    const fresh: StageDraft = { id: next, label: '', kanbanVisible: true, terminal: false, errorReturnToStageId: '', outcomes: [], requiresOutcome: false };
    const stages = terminal !== undefined && terminal.terminal
      ? [...current.stages.slice(0, -1), fresh, terminal]
      : [...current.stages, fresh];
    this.editing.set({ ...current, stages, rejection: null });
    this.selectedStageId.set(next);
  }

  protected removeStage(index: number): void {
    const current = this.editing();
    if (current === null) return;
    const removed = current.stages[index];
    if (removed === undefined) return;
    const linkedSteps = current.steps.filter((step) => step.stageId === removed.id).length;
    if (linkedSteps > 0) {
      this.editing.set({
        ...current,
        rejection: `Move the ${linkedSteps} step${linkedSteps === 1 ? '' : 's'} assigned to ${removed.label || removed.id} before removing this stage`,
      });
      return;
    }
    const referenced = current.stages.some(
      (stage) =>
        stage.errorReturnToStageId === removed.id ||
        stage.outcomes.some((outcome) => outcome.toStageId === removed.id),
    );
    if (referenced) {
      this.editing.set({ ...current, rejection: `Clear routes returning to ${removed.label || removed.id} before removing this stage` });
      return;
    }
    const stages = current.stages.filter((_, i) => i !== index);
    this.editing.set({ ...current, stages, rejection: null });
    this.selectedStageId.set(stages[Math.min(index, stages.length - 1)]?.id ?? null);
  }

  /**
   * Stage movement also regroups the flat step list, preserving order within
   * each stage so a simple stage move cannot create a backward execution path.
   */
  protected moveStage(index: number, delta: -1 | 1): void {
    const current = this.editing();
    if (current === null) return;
    const target = index + delta;
    if (target < 0 || target >= current.stages.length) return;
    const stages = [...current.stages];
    [stages[index], stages[target]] = [stages[target]!, stages[index]!];
    const structuralError = this.stageOrderError(stages);
    if (structuralError !== null) {
      this.editing.set({ ...current, rejection: structuralError });
      return;
    }
    const order = new Map(stages.map((stage, stageIndex) => [stage.id, stageIndex]));
    const steps = current.steps
      .map((step, stepIndex) => ({ step, stepIndex }))
      .sort((left, right) =>
        (order.get(left.step.stageId) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(right.step.stageId) ?? Number.MAX_SAFE_INTEGER) ||
        left.stepIndex - right.stepIndex,
      )
      .map(({ step }) => step);
    this.editing.set({ ...current, stages, steps, rejection: null });
  }

  protected canMoveStage(index: number, delta: -1 | 1): boolean {
    const current = this.editing();
    if (current === null) return false;
    const target = index + delta;
    if (target < 0 || target >= current.stages.length) return false;
    const stages = [...current.stages];
    [stages[index], stages[target]] = [stages[target]!, stages[index]!];
    return this.stageOrderError(stages) === null;
  }

  protected updateStage(index: number, patch: Partial<StageDraft>): void {
    const current = this.editing();
    if (current === null) return;
    this.editing.set({
      ...current,
      stages: current.stages.map((stage, i) => (i === index ? { ...stage, ...patch } : stage)),
      rejection: null,
    });
  }

  protected updateStageErrorReturn(index: number, value: string): void {
    this.updateStage(index, { errorReturnToStageId: value });
  }

  // ---- Stage outcome rules (S36) ----

  protected addOutcome(stageIndex: number): void {
    const current = this.editing();
    if (current === null) return;
    this.updateStage(stageIndex, {
      outcomes: [...current.stages[stageIndex]!.outcomes, { outcome: '', toStageId: '' }],
    });
  }

  protected removeOutcome(stageIndex: number, ruleIndex: number): void {
    const current = this.editing();
    if (current === null) return;
    const outcomes = current.stages[stageIndex]!.outcomes.filter((_, i) => i !== ruleIndex);
    this.updateStage(stageIndex, {
      outcomes,
      ...(outcomes.length === 0 ? { requiresOutcome: false } : {}),
    });
  }

  protected updateOutcome(stageIndex: number, ruleIndex: number, patch: Partial<{ outcome: string; toStageId: string }>): void {
    const current = this.editing();
    if (current === null) return;
    const outcomes = current.stages[stageIndex]!.outcomes.map((rule, i) =>
      i === ruleIndex ? { ...rule, ...patch } : rule,
    );
    this.updateStage(stageIndex, { outcomes });
  }

  // ---- Step mutations ----

  protected addStep(): void {
    const current = this.editing();
    if (current === null) return;
    const stage = current.stages.find((candidate) => !candidate.terminal) ?? current.stages[0];
    if (stage === undefined) return;
    const step: StepDraft = {
      id: this.nextStepId(current.steps),
      kind: 'command',
      stageId: stage.id,
      agentKind: 'coder',
      instructions: '',
      command: '',
      description: '',
    };
    const steps = [...current.steps];
    steps.splice(this.insertPositionFor(current, stage.id), 0, step);
    this.editing.set({ ...current, steps, rejection: null });
  }

  protected removeStep(index: number): void {
    const current = this.editing();
    if (current === null) return;
    this.editing.set({ ...current, steps: current.steps.filter((_, i) => i !== index), rejection: null });
  }

  protected moveStep(index: number, delta: -1 | 1): void {
    const current = this.editing();
    if (current === null) return;
    const target = index + delta;
    if (!this.canMoveStep(index, delta)) return;
    const steps = [...current.steps];
    [steps[index], steps[target]] = [steps[target]!, steps[index]!];
    this.editing.set({ ...current, steps, rejection: null });
  }

  protected canMoveStep(index: number, delta: -1 | 1): boolean {
    const steps = this.editing()?.steps;
    if (steps === undefined) return false;
    const target = index + delta;
    return target >= 0 && target < steps.length && steps[index]?.stageId === steps[target]?.stageId;
  }

  /** Changing stage also moves the step into that stage's contiguous run region. */
  protected assignStepToStage(index: number, stageId: string): void {
    const current = this.editing();
    const step = current?.steps[index];
    if (current === null || current === undefined || step === undefined || step.stageId === stageId) return;
    const without = current.steps.filter((_, stepIndex) => stepIndex !== index);
    const moved = { ...step, stageId };
    const next = { stages: current.stages, steps: without };
    without.splice(this.insertPositionFor(next, stageId), 0, moved);
    this.editing.set({ ...current, steps: without, rejection: null });
  }

  protected updateStepKind(index: number, kind: PipelineStepKind): void {
    this.updateStep(index, {
      kind,
      agentKind: kind === 'agent' ? 'coder' : '',
      instructions: '',
      command: '',
      description: '',
    });
  }

  protected updateStep(index: number, patch: Partial<StepDraft>): void {
    const current = this.editing();
    if (current === null) return;
    this.editing.set({
      ...current,
      steps: current.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)),
      rejection: null,
    });
  }

  /** The stages an error return or outcome rule may target: strictly earlier ones. */
  protected errorTargets(index: number): StageDraft[] {
    const current = this.editing();
    if (current === null) return [];
    return current.stages.slice(0, index);
  }

  /** Client-side pre-validation (the server re-validates the same rule).
   * Defensive against non-string drafts: it runs inside the render loop, and
   * a throw here aborts change detection for the whole view. */
  protected validate(name: string, stages: StageDraft[], steps: StepDraft[]): string | null {
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

  protected async save(): Promise<void> {
    const current = this.editing();
    const projectId = this.projectId();
    if (current === null || projectId === null) return;
    this.attemptedSave.set(true);
    const invalid = this.validate(current.name, current.stages, current.steps);
    if (invalid !== null) {
      this.editing.set({ ...current, rejection: null });
      return;
    }
    const pipeline = new Pipeline({
      id: current.id,
      name: text(current.name).trim(),
      revision: 0,
      stages: current.stages.map((stage) => {
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
      steps: current.steps.map((step) =>
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
    const ok = await this.pipelines.save(projectId, pipeline);
    if (!ok) {
      const latest = this.editing();
      if (latest !== null) this.editing.set({ ...latest, rejection: this.pipelines.rejection() ?? 'the server rejected the pipeline' });
      return;
    }
    this.attemptedSave.set(false);
    this.editing.set(null);
    this.selectedStageId.set(null);
  }

  protected async remove(pipelineId: string): Promise<void> {
    const projectId = this.projectId();
    if (projectId === null) return;
    const confirmed = await this.confirm.confirm({
      title: 'Delete this pipeline?',
      detail: 'Assigned cards block the deletion; reassign them first.',
      confirmLabel: 'delete',
      danger: true,
    });
    if (!confirmed) return;
    await this.pipelines.remove(projectId, pipelineId);
  }

  private patchDraft(patch: Partial<EditorDraft>): void {
    const current = this.editing();
    if (current === null) return;
    this.editing.set({ ...current, ...patch });
  }

  private stageOrderError(stages: StageDraft[]): string | null {
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

  private nextStageId(stages: StageDraft[]): string {
    let max = 0;
    for (const stage of stages) {
      const match = /^sg-(\d+)$/.exec(stage.id);
      if (match?.[1] !== undefined) max = Math.max(max, Number(match[1]));
    }
    return `sg-${max + 1}`;
  }

  private nextStepId(steps: StepDraft[]): string {
    let max = 0;
    for (const step of steps) {
      const match = /^st-(\d+)$/.exec(step.id);
      if (match?.[1] !== undefined) max = Math.max(max, Number(match[1]));
    }
    return `st-${max + 1}`;
  }

  /**
   * Where a new step for `stageId` joins the flat list: after the stage's
   * last step, or before the first step of a later stage — so the step
   * lands in the stage's run region (the forward path stays non-decreasing).
   */
  private insertPositionFor(current: { stages: StageDraft[]; steps: StepDraft[] }, stageId: string): number {
    const steps = current.steps;
    let last = -1;
    for (let i = 0; i < steps.length; i++) {
      if (steps[i]!.stageId === stageId) last = i;
    }
    if (last >= 0) return last + 1;
    const order = current.stages.findIndex((stage) => stage.id === stageId);
    for (let i = 0; i < steps.length; i++) {
      const stepOrder = current.stages.findIndex((stage) => stage.id === steps[i]!.stageId);
      if (stepOrder > order) return i;
    }
    return steps.length;
  }

  private stageDraftOf(stage: PipelineStage): StageDraft {
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

  private draftOf(step: PipelineStep): StepDraft {
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
}

/** Coerce an editable field to text (validate runs in the render path). */
function text(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}
