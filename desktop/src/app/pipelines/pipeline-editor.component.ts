import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, type LucideIconData } from 'lucide-angular';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Bot,
  Check,
  Plus,
  Save,
  SquareCheck,
  Terminal,
  Trash2,
  Workflow,
} from 'lucide-angular';

import { ShellService } from '../shell/shell.service';
import { ConfirmService } from '../core/confirm/confirm.service';
import { RestClient } from '../core/rest';
import {
  Pipeline,
  PipelineCatalog,
  PipelineStepKind,
  PIPELINE_AGENT_KINDS,
  type PipelineAgentCatalogEntry,
  type RuntimeStepCatalogEntry,
} from '../core/models/pipeline.models';
import { PipelineService } from './pipeline.service';
import { EditorDraft, StepDraft } from './editor-draft';

/** One backward route a step announces (outcome or failure recovery). */
interface StepRoute {
  readonly key: string;
  readonly label: string;
  readonly target: string;
  readonly kind: 'outcome' | 'failure';
}

/**
 * The pipeline editor (S4, staged in Phase 10; the linear visual editor in
 * S37). Pipelines are user-authored (the ownership rule): the view lists
 * the project's pipelines and authors them from scratch. Editing is a full
 * editor that fills the route: a linear diagram of the pipeline's step
 * nodes, with a right-hand side panel that opens for the selected node's
 * settings. A step made board-visible is its own swimlane; an agent step's
 * agent kind is picked from the backend's shipped agents. The draft's rules
 * (conversion, validation, reordering, id allocation) live on `EditorDraft`.
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
  private readonly confirm = inject(ConfirmService);
  private readonly rest = inject(RestClient);

  protected readonly projectId = computed(() => this.shell.activeTabId());
  protected readonly list = computed(() => this.pipelines.pipelines());

  /** The server's executor catalog (agents + runtime steps); empty until loaded. */
  protected readonly catalog = signal<PipelineCatalog>({ agents: [], runtimeSteps: [] });

  protected readonly kinds: readonly PipelineStepKind[] = ['agent', 'command', 'human'];

  /** The working copy being authored; null shows the list. */
  protected readonly editing = signal<EditorDraft | null>(null);

  /** The step node selected in the diagram (opens the node side panel). */
  protected readonly selectedStepId = signal<string | null>(null);

  protected readonly selectedStepIndex = computed(() => {
    const current = this.selectedStepId();
    const draft = this.editing();
    if (current === null || draft === null) return null;
    const index = draft.steps.findIndex((step) => step.id === current);
    return index < 0 ? null : index;
  });

  protected readonly selectedStepDraft = computed<StepDraft | null>(() => {
    const current = this.editing();
    const index = this.selectedStepIndex();
    return current !== null && index !== null ? (current.steps[index] ?? null) : null;
  });

  /** Client-side validation runs live, but only surfaces after a save attempt. */
  private readonly attemptedSave = signal(false);

  protected readonly validationError = computed(() => this.editing()?.validate() ?? null);

  protected readonly showError = computed(() => this.attemptedSave() && this.validationError() !== null);

  protected readonly icons = {
    workflow: Workflow,
    plus: Plus,
    trash: Trash2,
    save: Save,
    back: ArrowLeft,
    up: ArrowUp,
    down: ArrowDown,
    done: Check,
  };

  constructor() {
    effect(() => {
      const draft = this.editing();
      if (draft !== null && draft.projectId !== this.projectId()) this.cancel();
    });
    effect(() => {
      if (this.rest.serverBase !== null) void this.loadCatalog();
    });
  }

  private async loadCatalog(): Promise<void> {
    const response = await this.rest.get<PipelineCatalog>('/catalog');
    if (response === null || !response.ok) return;
    const agents = Array.isArray(response.body.agents) ? response.body.agents : [];
    const runtimeSteps = Array.isArray(response.body.runtimeSteps) ? response.body.runtimeSteps : [];
    this.catalog.set({ agents, runtimeSteps });
  }

  // ---- Executor catalog ----

  /** The selectable predefined agents (catalog first, local kinds as fallback). */
  protected readonly agentOptions = computed<readonly PipelineAgentCatalogEntry[]>(() => {
    const agents = this.catalog().agents;
    if (agents.length > 0) return agents;
    return PIPELINE_AGENT_KINDS.map((id) => ({ id, label: id, description: '' }));
  });

  protected readonly runtimeSteps = computed<readonly RuntimeStepCatalogEntry[]>(
    () => this.catalog().runtimeSteps,
  );

  protected agentLabel(agentKind: string): string {
    return this.agentOptions().find((agent) => agent.id === agentKind)?.label ?? (agentKind || 'agent');
  }

  protected agentDescription(agentKind: string): string {
    return this.agentOptions().find((agent) => agent.id === agentKind)?.description ?? '';
  }

  /** Applies a runtime preset's command to the selected command step. */
  protected applyRuntimeStep(index: number, presetId: string): void {
    const preset = this.runtimeSteps().find((step) => step.id === presetId);
    if (preset === undefined) return;
    this.updateStep(index, { command: preset.command });
  }

  // ---- List (browse) mode ----

  protected stepSummary(pipeline: Pipeline): string {
    return pipeline.steps.map((step) => step.label).join(' → ');
  }

  protected canEdit(): boolean {
    return this.projectId() !== null;
  }

  // ---- Diagram node representation ----

  protected stepIcon(kind: PipelineStepKind): LucideIconData {
    switch (kind) {
      case 'command':
        return Terminal;
      case 'human':
        return SquareCheck;
      default:
        return Bot;
    }
  }

  protected nodeLabel(step: StepDraft): string {
    if (step.terminal) return 'done';
    switch (step.kind) {
      case 'agent':
        return step.agentKind.trim() !== '' ? this.agentLabel(step.agentKind) : 'agent';
      case 'command':
        return step.description?.trim() || 'command';
      case 'human':
        return 'approval';
    }
  }

  protected nodeDetail(step: StepDraft): string {
    if (step.terminal) return 'completion';
    switch (step.kind) {
      case 'agent':
        return this.agentLabel(step.agentKind);
      case 'command':
        return step.command || 'shell command';
      case 'human':
        return step.description || 'approval prompt';
    }
  }

  /** The step's backward routes: named outcomes plus its failure recovery. */
  protected stepRoutes(index: number): StepRoute[] {
    const draft = this.editing();
    const step = draft?.steps[index];
    if (draft === null || step === undefined || step.terminal) return [];
    const routes: StepRoute[] = [];
    for (const rule of step.outcomes) {
      if (rule.toStepId.trim() === '') continue;
      routes.push({
        key: `outcome-${rule.outcome}-${rule.toStepId}`,
        label: rule.outcome.trim() || 'outcome',
        target: this.nodeLabelFor(draft, rule.toStepId),
        kind: 'outcome',
      });
    }
    if (step.errorReturnToStepId.trim() !== '') {
      routes.push({
        key: 'failure',
        label: 'failure',
        target: this.nodeLabelFor(draft, step.errorReturnToStepId),
        kind: 'failure',
      });
    }
    return routes;
  }

  private nodeLabelFor(draft: EditorDraft, id: string): string {
    const target = draft.steps.find((step) => step.id === id);
    return target === undefined ? id : this.nodeLabel(target);
  }

  // ---- Entering / leaving edit mode ----

  protected newPipeline(): void {
    const projectId = this.projectId();
    if (projectId === null) return;
    this.openDraft(EditorDraft.newDraft(projectId));
  }

  protected edit(pipeline: Pipeline): void {
    const projectId = this.projectId();
    if (projectId === null) return;
    this.openDraft(EditorDraft.fromPipeline(projectId, pipeline));
  }

  private openDraft(draft: EditorDraft): void {
    this.attemptedSave.set(false);
    this.editing.set(draft);
    this.selectedStepId.set(null);
  }

  protected cancel(): void {
    this.attemptedSave.set(false);
    this.editing.set(null);
    this.selectedStepId.set(null);
  }

  protected updateName(name: string): void {
    this.update((draft) => draft.withName(name));
  }

  // ---- Node selection ----

  protected selectStep(index: number): void {
    this.selectedStepId.set(this.editing()?.steps[index]?.id ?? null);
  }

  private selectStepById(id: string): void {
    this.selectedStepId.set(id);
  }

  // ---- Step (node) mutations ----

  protected addStep(): void {
    const current = this.editing();
    if (current === null) return;
    const before = new Set(current.steps.map((step) => step.id));
    this.editing.set(current.addStep());
    this.selectFreshStep(before);
  }

  protected insertStep(afterIndex: number): void {
    const current = this.editing();
    if (current === null) return;
    const before = new Set(current.steps.map((step) => step.id));
    this.editing.set(current.insertStep(afterIndex));
    this.selectFreshStep(before);
  }

  /** Selects the step the mutation just added (its id is newly allocated). */
  private selectFreshStep(before: ReadonlySet<string>): void {
    const fresh = this.editing()?.steps.find((step) => !before.has(step.id));
    if (fresh !== undefined) this.selectStepById(fresh.id);
  }

  protected removeStep(index: number): void {
    const current = this.editing();
    if (current === null) return;
    const removedId = current.steps[index]?.id ?? null;
    this.editing.set(current.removeStep(index));
    if (this.selectedStepId() === removedId) this.selectedStepId.set(null);
  }

  protected moveStep(index: number, delta: -1 | 1): void {
    this.update((draft) => draft.moveStep(index, delta));
  }

  protected canMoveStep(index: number, delta: -1 | 1): boolean {
    return this.editing()?.canMoveStep(index, delta) ?? false;
  }

  protected updateStepKind(index: number, kind: PipelineStepKind): void {
    this.update((draft) => draft.updateStepKind(index, kind));
  }

  protected updateStep(index: number, patch: Partial<StepDraft>): void {
    this.update((draft) => draft.updateStep(index, patch));
  }

  // ---- Step outcome rules (S36) ----

  protected addOutcome(stepIndex: number): void {
    this.update((draft) => draft.addOutcome(stepIndex));
  }

  protected removeOutcome(stepIndex: number, ruleIndex: number): void {
    this.update((draft) => draft.removeOutcome(stepIndex, ruleIndex));
  }

  protected updateOutcome(stepIndex: number, ruleIndex: number, patch: Partial<{ outcome: string; toStepId: string }>): void {
    this.update((draft) => draft.updateOutcome(stepIndex, ruleIndex, patch));
  }

  /** The steps an error return or outcome rule may target: strictly earlier ones. */
  protected errorTargets(index: number): StepDraft[] {
    return this.editing()?.errorTargets(index) ?? [];
  }

  // ---- Save / delete ----

  protected async save(): Promise<void> {
    const current = this.editing();
    if (current === null) return;
    this.attemptedSave.set(true);
    if (current.validate() !== null) {
      this.editing.set(current.with({ rejection: null }));
      return;
    }
    const ok = await this.pipelines.save(current.projectId, current.toPipeline());
    if (!ok) {
      const latest = this.editing();
      if (latest !== null) {
        this.editing.set(latest.with({ rejection: this.pipelines.rejection() ?? 'the server rejected the pipeline' }));
      }
      return;
    }
    this.attemptedSave.set(false);
    this.editing.set(null);
    this.selectedStepId.set(null);
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
