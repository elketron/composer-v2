import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';
import { ArrowDown, ArrowUp, Plus, Save, Trash2, Workflow, X } from 'lucide-angular';

import { ShellService } from '../shell/shell.service';
import { ConfirmService } from '../core/confirm/confirm.service';
import { SettingsService } from '../settings/settings.service';
import { Pipeline, PipelineStepKind } from '../core/models/pipeline.models';
import { PipelineService } from './pipeline.service';
import { EditorDraft, StageDraft, StepDraft } from './editor-draft';

/**
 * The pipeline editor (S4, staged in Phase 10; the linear visual editor in
 * S37). Pipelines are user-authored (the ownership rule): the view lists
 * the project's pipelines and authors them from scratch — a name, the
 * compact stage path and a flat ordered step list with explicit stage
 * assignment. Save publishes requestPipelineSave (the server allocates fresh ids
 * and revisions, upserts known ones, and re-validates); deletions
 * tombstone the default. The draft's rules (conversion, validation,
 * reordering, id allocation) live on `EditorDraft`; this component renders
 * it and forwards edits.
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

  protected readonly validationError = computed(() => this.editing()?.validate() ?? null);

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
    const draft = EditorDraft.newDraft();
    this.editing.set(draft);
    this.selectedStageId.set(draft.firstStageId());
  }

  protected edit(pipeline: Pipeline): void {
    if (!this.canEdit()) return;
    this.attemptedSave.set(false);
    const draft = EditorDraft.fromPipeline(pipeline);
    this.editing.set(draft);
    this.selectedStageId.set(draft.firstStageId());
  }

  protected cancel(): void {
    this.attemptedSave.set(false);
    this.editing.set(null);
    this.selectedStageId.set(null);
  }

  protected updateName(name: string): void {
    this.update((draft) => draft.withName(name));
  }

  protected selectStage(index: number): void {
    this.selectedStageId.set(this.editing()?.stages[index]?.id ?? null);
  }

  // ---- Stage mutations ----

  protected addStage(): void {
    const current = this.editing();
    if (current === null) return;
    const { draft, stageId } = current.addStage();
    this.editing.set(draft);
    this.selectedStageId.set(stageId);
  }

  protected removeStage(index: number): void {
    const current = this.editing();
    if (current === null) return;
    const before = current.stages.length;
    const next = current.removeStage(index);
    this.editing.set(next);
    if (next.stages.length < before) {
      this.selectedStageId.set(next.stages[Math.min(index, next.stages.length - 1)]?.id ?? null);
    }
  }

  protected moveStage(index: number, delta: -1 | 1): void {
    this.update((draft) => draft.moveStage(index, delta));
  }

  protected canMoveStage(index: number, delta: -1 | 1): boolean {
    return this.editing()?.canMoveStage(index, delta) ?? false;
  }

  protected updateStage(index: number, patch: Partial<StageDraft>): void {
    this.update((draft) => draft.updateStage(index, patch));
  }

  protected updateStageErrorReturn(index: number, value: string): void {
    this.updateStage(index, { errorReturnToStageId: value });
  }

  // ---- Stage outcome rules (S36) ----

  protected addOutcome(stageIndex: number): void {
    this.update((draft) => draft.addOutcome(stageIndex));
  }

  protected removeOutcome(stageIndex: number, ruleIndex: number): void {
    this.update((draft) => draft.removeOutcome(stageIndex, ruleIndex));
  }

  protected updateOutcome(stageIndex: number, ruleIndex: number, patch: Partial<{ outcome: string; toStageId: string }>): void {
    this.update((draft) => draft.updateOutcome(stageIndex, ruleIndex, patch));
  }

  /** The stages an error return or outcome rule may target: strictly earlier ones. */
  protected errorTargets(index: number): StageDraft[] {
    return this.editing()?.errorTargets(index) ?? [];
  }

  // ---- Step mutations ----

  protected addStep(): void {
    this.update((draft) => draft.addStep());
  }

  protected removeStep(index: number): void {
    this.update((draft) => draft.removeStep(index));
  }

  protected moveStep(index: number, delta: -1 | 1): void {
    this.update((draft) => draft.moveStep(index, delta));
  }

  protected canMoveStep(index: number, delta: -1 | 1): boolean {
    return this.editing()?.canMoveStep(index, delta) ?? false;
  }

  /** Changing stage also moves the step into that stage's contiguous run region. */
  protected assignStepToStage(index: number, stageId: string): void {
    this.update((draft) => draft.assignStepToStage(index, stageId));
  }

  protected updateStepKind(index: number, kind: PipelineStepKind): void {
    this.update((draft) => draft.updateStepKind(index, kind));
  }

  protected updateStep(index: number, patch: Partial<StepDraft>): void {
    this.update((draft) => draft.updateStep(index, patch));
  }

  protected async save(): Promise<void> {
    const current = this.editing();
    const projectId = this.projectId();
    if (current === null || projectId === null) return;
    this.attemptedSave.set(true);
    if (current.validate() !== null) {
      this.editing.set(current.with({ rejection: null }));
      return;
    }
    const ok = await this.pipelines.save(projectId, current.toPipeline());
    if (!ok) {
      const latest = this.editing();
      if (latest !== null) {
        this.editing.set(latest.with({ rejection: this.pipelines.rejection() ?? 'the server rejected the pipeline' }));
      }
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

  private update(fn: (draft: EditorDraft) => EditorDraft): void {
    const current = this.editing();
    if (current === null) return;
    this.editing.set(fn(current));
  }
}