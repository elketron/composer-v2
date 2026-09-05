import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';
import { ArrowDown, ArrowUp, Plus, Save, Trash2, Workflow, X } from 'lucide-angular';

import { ShellService } from '../shell/shell.service';
import {
  Pipeline,
  PipelineStep,
  PipelineStepKind,
} from '../core/models/pipeline.models';
import { PipelineService } from './pipeline.service';

/** One row of the editor's step builder (a mutable working copy). */
interface StepDraft {
  id: string;
  kind: PipelineStepKind;
  agentKind: string;
  instructions: string;
  command: string;
  description: string;
  retries: number | null;
}

/**
 * The pipeline editor (S4). Pipelines are user-authored (the ownership
 * rule): the view lists the project's pipelines and authors them from
 * scratch — a name plus an ordered step list with per-kind fields. Save
 * publishes requestPipelineSave (the server allocates fresh ids, upserts
 * known ones, and re-validates); deletions tombstone the default.
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

  protected readonly projectId = computed(() => this.shell.activeTabId());
  protected readonly list = computed(() => this.pipelines.pipelines());

  protected readonly kinds: readonly PipelineStepKind[] = ['agent', 'command', 'human'];

  /** The working copy being authored; null shows the list. */
  protected readonly editing = signal<{
    id: string;
    name: string;
    steps: StepDraft[];
    rejection: string | null;
  } | null>(null);

  /** Client-side validation runs live, but only surfaces after a save attempt. */
  private readonly attemptedSave = signal(false);

  protected readonly validationError = computed(() => {
    const draft = this.editing();
    return draft ? this.validate(draft.name, draft.steps) : null;
  });

  protected readonly showError = computed(() => this.attemptedSave() && this.validationError() !== null);

  protected readonly icons = { workflow: Workflow, plus: Plus, trash: Trash2, save: Save, close: X, up: ArrowUp, down: ArrowDown };

  protected stepSummary(pipeline: Pipeline): string {
    return pipeline.steps.map((step) => this.kindLabel(step.kind)).join(' → ');
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
    this.editing.set({ id: '', name: '', steps: [this.emptyDraft('agent')], rejection: null });
  }

  protected edit(pipeline: Pipeline): void {
    if (!this.canEdit()) return;
    this.editing.set({
      id: pipeline.id,
      name: pipeline.name,
      steps: pipeline.steps.map((step) => this.draftOf(step)),
      rejection: null,
    });
  }

  protected cancel(): void {
    this.editing.set(null);
  }

  protected updateName(name: string): void {
    const current = this.editing();
    if (current === null) return;
    this.editing.set({ ...current, name, rejection: null });
  }

  protected addStep(): void {
    const current = this.editing();
    if (current === null) return;
    this.editing.set({
      ...current,
      steps: [...current.steps, this.emptyDraft('command')],
      rejection: null,
    });
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
    if (target < 0 || target >= current.steps.length) return;
    const steps = [...current.steps];
    [steps[index], steps[target]] = [steps[target]!, steps[index]!];
    this.editing.set({ ...current, steps, rejection: null });
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

  protected updateStepRetries(index: number, value: string): void {
    this.updateStep(index, { retries: value === '' ? null : Number(value) });
  }

  /** Client-side pre-validation (the server re-validates the same rule).
   * Defensive against non-string drafts: it runs inside the render loop, and
   * a throw here aborts change detection for the whole view. */
  protected validate(name: string, steps: StepDraft[]): string | null {
    const nameText = text(name);
    if (nameText === '') return 'Pipeline name is required';
    if (steps.length === 0) return 'A pipeline needs at least one step';
    const seen = new Set<string>();
    for (const [index, step] of steps.entries()) {
      const id = text(step.id);
      if (id === '') return `Step ${index + 1} needs an id`;
      if (seen.has(id)) return `Step id '${id}' appears twice`;
      seen.add(id);
      const missing = new PipelineStep({
        id,
        kind: step.kind,
        ...(text(step.agentKind) ? { agentKind: text(step.agentKind) } : {}),
        ...(text(step.instructions) ? { instructions: text(step.instructions) } : {}),
        ...(text(step.command) ? { command: text(step.command) } : {}),
        ...(text(step.description) ? { description: text(step.description) } : {}),
        ...(step.retries !== null ? { retries: step.retries } : {}),
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
    const invalid = this.validate(current.name, current.steps);
    if (invalid !== null) {
      this.editing.set({ ...current, rejection: null });
      return;
    }
    const pipeline = new Pipeline({
      id: current.id,
      name: text(current.name).trim(),
      steps: current.steps.map((step) =>
        new PipelineStep({
          id: text(step.id).trim(),
          kind: step.kind,
          ...(text(step.agentKind).trim() ? { agentKind: text(step.agentKind).trim() } : {}),
          ...(text(step.instructions).trim() ? { instructions: text(step.instructions).trim() } : {}),
          ...(text(step.command).trim() ? { command: text(step.command).trim() } : {}),
          ...(text(step.description).trim() ? { description: text(step.description).trim() } : {}),
          ...(step.retries !== null ? { retries: step.retries } : {}),
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
  }

  protected async remove(pipelineId: string): Promise<void> {
    const projectId = this.projectId();
    if (projectId === null) return;
    await this.pipelines.remove(projectId, pipelineId);
  }

  private draftOf(step: PipelineStep): StepDraft {
    return {
      id: step.id,
      kind: step.kind,
      agentKind: step.agentKind ?? '',
      instructions: step.instructions ?? '',
      command: step.command ?? '',
      description: step.description ?? '',
      retries: step.data.retries ?? null,
    };
  }

  private emptyDraft(kind: PipelineStepKind): StepDraft {
    return { id: '', kind, agentKind: 'coder', instructions: '', command: '', description: '', retries: null };
  }
}

/** Coerce an editable field to text (validate runs in the render path). */
function text(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}
