import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  signal,
  viewChild,
  viewChildren,
  type ElementRef,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, type LucideIconData } from 'lucide-angular';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BookOpen,
  Bot,
  Check,
  Code,
  Copy,
  EllipsisVertical,
  FlaskConical,
  Folder,
  Plus,
  Rocket,
  Save,
  Server,
  SquareCheck,
  Pause,
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
  PIPELINE_CATEGORIES,
  type PipelineAgentCatalogEntry,
  type PipelineCategoryCatalogEntry,
  type RuntimeStepCatalogEntry,
} from '../core/models/pipeline.models';
import { PipelineService } from './pipeline.service';
import { EditorDraft, StepDraft } from './editor-draft';
import {
  paletteModel,
  STEP_KIND_BADGES,
  type JustRecipeEntry,
  type StepPreset,
  type StepTypeMeta,
} from './step-types';

/** One sidebar group: a category and the pipelines filed under it. */
interface SidebarGroup {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIconData;
  readonly pipelines: Pipeline[];
}

/** One backward edge of the diagram's route overlay (returns work earlier). */
interface BackwardEdge {
  readonly key: string;
  readonly path: string;
  readonly label: string;
  readonly labelX: number;
  readonly labelY: number;
}

/** The flow-relative position of a node (the overflow menu's anchor). */
interface NodeRect {
  readonly right: number;
  readonly bottom: number;
}

/** The palette's anchor: append at the end, or insert after a step index. */
interface PaletteAnchor {
  readonly afterIndex: number | null;
}

/** One definition stat row of the settings tab. */
interface DefinitionStat {
  readonly label: string;
  readonly value: string;
}

/** The sidebar icon per category id; unknown ids fall back to General. */
const CATEGORY_ICONS: Readonly<Record<string, LucideIconData>> = {
  coding: Code,
  documentation: BookOpen,
  research: FlaskConical,
  release: Rocket,
  infrastructure: Server,
};

const GENERAL_ICON = Folder;

/**
 * The pipeline editor (S37 redesign): a category-grouped sidebar of the
 * project's pipelines beside a full editor — a header (name, save, overflow
 * menu), a Steps/Settings tab bar, and per tab the flow diagram with its
 * inspector or the pipeline's settings. Pipelines are user-authored (the
 * ownership rule); a step made board-visible is its own swimlane; an agent
 * step's agent kind is picked from the backend's shipped agents. The
 * draft's rules (conversion, validation, reordering, id allocation) live on
 * `EditorDraft`.
 */
@Component({
  selector: 'app-pipeline-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, FormsModule],
  templateUrl: './pipeline-editor.component.html',
  styleUrl: './pipeline-editor.component.scss',
  host: {
    '(document:click)': 'onDocumentClick()',
  },
})
export class PipelineEditorComponent {
  private readonly shell = inject(ShellService);
  private readonly pipelines = inject(PipelineService);
  private readonly confirm = inject(ConfirmService);
  private readonly rest = inject(RestClient);

  protected readonly projectId = computed(() => this.shell.activeTabId());
  protected readonly list = computed(() => this.pipelines.pipelines());

  /** The server's executor catalog (agents + runtime steps + categories); empty until loaded. */
  protected readonly catalog = signal<PipelineCatalog>({ agents: [], runtimeSteps: [], categories: [] });

  /** The active project's justfile recipes (the Set step's presets). */
  protected readonly justRecipes = signal<readonly JustRecipeEntry[]>([]);

  protected readonly kinds: readonly PipelineStepKind[] = ['agent', 'command', 'human', 'backlog'];

  /** The working copy being authored; null shows the empty main area. */
  protected readonly editing = signal<EditorDraft | null>(null);

  /** The active editor tab (the mockup's Steps / Settings). */
  protected readonly editorTab = signal<'steps' | 'settings'>('steps');

  /** The header overflow menu (delete pipeline). */
  protected readonly menuOpen = signal(false);

  /** The add-step palette's anchor (null = closed). */
  protected readonly paletteAnchor = signal<PaletteAnchor | null>(null);

  /** The node whose overflow menu is open (step id; null = closed). */
  protected readonly nodeMenuFor = signal<string | null>(null);

  /** The diagram's measured backward edges and node anchors (flow-relative). */
  protected readonly backwardEdges = signal<readonly BackwardEdge[]>([]);
  protected readonly nodeRects = signal<readonly NodeRect[]>([]);

  private readonly nodeEls = viewChildren<ElementRef<HTMLElement>>('nodeEl');
  private readonly flowEl = viewChild<ElementRef<HTMLElement>>('flowEl');
  private resizeObserver: ResizeObserver | null = null;

  /** The step node selected in the diagram (opens the node side panel). */
  protected readonly selectedStepId = signal<string | null>(null);

  /** The inspector's tab (General / Outcomes / Advanced). */
  protected readonly inspectorTab = signal<'general' | 'outcomes' | 'advanced'>('general');

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
    more: EllipsisVertical,
    copy: Copy,
  };

  // ---- Sidebar (category groups) ----

  /** The category list the sidebar groups by (catalog first, local fallback). */
  protected readonly categoryOptions = computed<readonly PipelineCategoryCatalogEntry[]>(() => {
    const categories = this.catalog().categories;
    return categories.length > 0 ? categories : PIPELINE_CATEGORIES;
  });

  /** The pipelines grouped by category (unknown/absent under General, last). */
  protected readonly sidebarGroups = computed<readonly SidebarGroup[]>(() => {
    const categories = this.categoryOptions();
    const groups = categories.map((category) => ({
      id: category.id,
      label: category.label,
      icon: CATEGORY_ICONS[category.id] ?? GENERAL_ICON,
      pipelines: [] as Pipeline[],
    }));
    const general: SidebarGroup = { id: 'general', label: 'General', icon: GENERAL_ICON, pipelines: [] };
    for (const pipeline of this.list()) {
      const match = groups.find((group) => group.id === pipeline.category);
      (match ?? general).pipelines.push(pipeline);
    }
    return [...groups, general].filter((group) => group.pipelines.length > 0);
  });

  protected isActive(pipelineId: string): boolean {
    return this.editing()?.id === pipelineId;
  }

  constructor() {
    effect(() => {
      const draft = this.editing();
      if (draft !== null && draft.projectId !== this.projectId()) this.cancel();
    });
    effect(() => {
      if (this.rest.serverBase !== null) void this.loadCatalog();
    });
    // The project's justfile recipes (the Set step palette's presets and
    // the command inspector's dropdown) reload with the project.
    effect(() => {
      const projectId = this.projectId();
      if (projectId !== null && this.rest.serverBase !== null) void this.loadRecipes(projectId);
    });
    // The route overlay measures the rendered nodes after each layout pass
    // (draft edits and the inspector opening/closing both shift geometry;
    // the ResizeObserver covers width changes between renders).
    afterRenderEffect(() => {
      const flow = this.flowEl()?.nativeElement ?? null;
      if (flow !== null && this.resizeObserver === null && typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(() => this.measureDiagram());
        this.resizeObserver.observe(flow);
      }
      void this.nodeEls().length;
      // Selection toggles the inspector, which shifts the flow's width.
      void this.selectedStepId();
      this.measureBackwardEdges();
    });
    inject(DestroyRef).onDestroy(() => this.resizeObserver?.disconnect());
  }

  private async loadCatalog(): Promise<void> {
    const response = await this.rest.get<PipelineCatalog>('/catalog');
    if (response === null || !response.ok) return;
    const agents = Array.isArray(response.body.agents) ? response.body.agents : [];
    const runtimeSteps = Array.isArray(response.body.runtimeSteps) ? response.body.runtimeSteps : [];
    const categories = Array.isArray(response.body.categories) ? response.body.categories : [];
    this.catalog.set({ agents, runtimeSteps, categories });
  }

  private async loadRecipes(projectId: string): Promise<void> {
    const response = await this.rest.get<{ recipes: readonly JustRecipeEntry[] }>(
      `/justfile?projectId=${projectId}`,
    );
    const recipes = response !== null && response.ok ? (response.body.recipes ?? []) : [];
    this.justRecipes.set(recipes.filter((recipe) => typeof recipe?.name === 'string' && recipe.name !== ''));
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

  /** Applies a justfile recipe (`just <name>`) to the selected command step. */
  protected applyJustRecipe(index: number, recipeName: string): void {
    if (recipeName.trim() === '') return;
    this.updateStep(index, { command: `just ${recipeName.trim()}` });
  }

  // ---- Diagram node representation ----

  /** The palette the add-step popover renders (registry + catalog presets). */
  protected readonly paletteModel = computed(() =>
    paletteModel(this.agentOptions(), this.runtimeSteps(), this.justRecipes()),
  );

  /** The type badge vocabulary (Agent / Approval / Set / Completion). */
  protected stepBadge(step: StepDraft): string {
    return STEP_KIND_BADGES[step.terminal ? 'completion' : step.kind];
  }

  /** The inspector's header: "Step 2 — reviewer". */
  protected panelTitle(step: StepDraft): string {
    const index = this.selectedStepIndex();
    return `Step ${index === null ? '?' : index + 1} — ${this.nodeLabel(step)}`;
  }

  protected isTerminalStep(stepId: string): boolean {
    return this.editing()?.steps.find((step) => step.id === stepId)?.terminal === true;
  }

  protected stepIcon(kind: PipelineStepKind): LucideIconData {
    switch (kind) {
      case 'command':
        return Terminal;
      case 'human':
        return SquareCheck;
      case 'backlog':
        return Pause;
      default:
        return Bot;
    }
  }

  /** The step type's one-line description (from the step-type registry). */
  protected stepTypeHint(kind: PipelineStepKind): string {
    return this.paletteModel().find((type) => type.kind === kind)?.description ?? '';
  }

  protected nodeLabel(step: StepDraft): string {
    if (step.terminal) return step.description?.trim() || 'done';
    switch (step.kind) {
      case 'agent':
        return step.agentKind.trim() !== '' ? this.agentLabel(step.agentKind) : 'agent';
      case 'command':
        return step.description?.trim() || 'command';
      case 'human':
        return 'approval';
      case 'backlog':
        return step.description?.trim() || 'backlog';
    }
  }

  protected nodeDetail(step: StepDraft): string {
    if (step.terminal) return 'Mark card as complete.';
    switch (step.kind) {
      case 'agent':
        return step.instructions?.trim() || this.agentLabel(step.agentKind);
      case 'command':
        return step.command || 'shell command';
      case 'human':
        return step.description || 'approval prompt';
      case 'backlog':
        return step.description || 'parks the card until moved onward';
    }
  }

  /** The step's named outcomes that proceed (green chips on the forward edge). */
  protected proceedOutcomes(index: number): readonly string[] {
    const step = this.editing()?.steps[index];
    if (step === undefined || step.terminal) return [];
    return step.outcomes
      .filter((rule) => rule.toStepId.trim() === '')
      .map((rule) => rule.outcome.trim() || 'outcome');
  }

  // ---- Diagram geometry (the route overlay + node menus) ----

  /** Re-measures the diagram's nodes (draft edits and resizes). */
  private measureDiagram(): void {
    const flow = this.flowEl()?.nativeElement;
    if (flow === undefined) return;
    const flowRect = flow.getBoundingClientRect();
    const rects = this.nodeEls().map((el) => {
      const rect = el.nativeElement.getBoundingClientRect();
      return {
        right: rect.right - flowRect.left,
        bottom: rect.bottom - flowRect.top,
      };
    });
    this.nodeRects.set(rects);
    this.measureBackwardEdges();
  }

  /**
   * The backward routes as curved left-side edges (a route leaves the
   * step's left edge and re-enters the earlier lane's node).
   */
  private measureBackwardEdges(): void {
    const draft = this.editing();
    if (draft === null) {
      this.backwardEdges.set([]);
      return;
    }
    const flow = this.flowEl()?.nativeElement;
    if (flow === undefined) return;
    const flowRect = flow.getBoundingClientRect();
    const rects = this.nodeEls().map((el) => {
      const rect = el.nativeElement.getBoundingClientRect();
      return {
        left: rect.left - flowRect.left,
        centerY: rect.top - flowRect.top + rect.height / 2,
      };
    });
    const edges: BackwardEdge[] = [];
    let lane = 0;
    for (const [index, step] of draft.steps.entries()) {
      if (step.terminal) continue;
      const routes: Array<{ kind: string; label: string; toStepId: string }> = [
        ...step.outcomes
          .filter((rule) => rule.toStepId.trim() !== '')
          .map((rule) => ({
            kind: 'outcome',
            label: rule.outcome.trim() || 'outcome',
            toStepId: rule.toStepId,
          })),
        ...(step.errorReturnToStepId.trim() !== ''
          ? [{ kind: 'failure', label: 'failure', toStepId: step.errorReturnToStepId }]
          : []),
      ];
      for (const route of routes) {
        const targetIndex = draft.steps.findIndex((candidate) => candidate.id === route.toStepId);
        const from = rects[index];
        const to = rects[targetIndex];
        if (from === undefined || to === undefined || targetIndex < 0 || targetIndex >= index) continue;
        const x0 = from.left - 8;
        const y0 = from.centerY;
        const x1 = to.left - 8;
        const y1 = to.centerY;
        const gutter = Math.min(x0, x1) - 36 - lane * 26;
        lane += 1;
        edges.push({
          key: `${step.id}-${route.kind}-${route.toStepId}-${edges.length}`,
          path: `M ${x0} ${y0} C ${gutter} ${y0}, ${gutter} ${y1}, ${x1} ${y1}`,
          label: route.label,
          labelX: (x0 + 6 * gutter + x1) / 8,
          labelY: (y0 + y1) / 2,
        });
      }
    }
    this.backwardEdges.set(edges);
  }

  // ---- Add-step palette ----

  protected openPalette(afterIndex: number | null): void {
    this.nodeMenuFor.set(null);
    this.paletteAnchor.update((current) =>
      current !== null && current.afterIndex === afterIndex ? null : { afterIndex },
    );
  }

  protected async applyPreset(type: StepTypeMeta, preset: StepPreset): Promise<void> {
    const anchor = this.paletteAnchor();
    this.paletteAnchor.set(null);
    if (type.kind === 'completion') {
      // The completion step is the pinned terminal node; both presets select
      // it ("Custom completion" renames it in the inspector).
      const draft = this.editing();
      this.selectedStepId.set(draft?.steps[draft.steps.length - 1]?.id ?? null);
      return;
    }
    const current = this.editing();
    if (current === null) return;
    const before = new Set(current.steps.map((step) => step.id));
    const next =
      anchor === null || anchor.afterIndex === null
        ? current.addStep(preset.patch)
        : current.insertStep(anchor.afterIndex, preset.patch);
    this.editing.set(next);
    this.selectFreshStep(before);
  }

  // ---- Node overflow menu ----

  protected toggleNodeMenu(stepId: string): void {
    this.paletteAnchor.set(null);
    this.nodeMenuFor.update((current) => (current === stepId ? null : stepId));
  }

  protected nodeMenuPosition(stepId: string): { left: number; top: number } | null {
    const index = this.editing()?.steps.findIndex((step) => step.id === stepId) ?? -1;
    const rect = this.nodeRects()[index];
    return rect === undefined ? null : { left: rect.right - 8, top: rect.bottom + 4 };
  }

  protected duplicateStep(stepId: string): void {
    this.nodeMenuFor.set(null);
    const index = this.editing()?.steps.findIndex((step) => step.id === stepId) ?? -1;
    if (index < 0) return;
    const before = new Set(this.editing()?.steps.map((step) => step.id) ?? []);
    this.update((draft) => draft.duplicateStep(index));
    this.selectFreshStep(before);
  }

  protected deleteStep(stepId: string): void {
    this.nodeMenuFor.set(null);
    const index = this.editing()?.steps.findIndex((step) => step.id === stepId) ?? -1;
    if (index < 0) return;
    this.removeStep(index);
  }

  // ---- Entering / leaving edit mode ----

  protected newPipeline(): void {
    const projectId = this.projectId();
    if (projectId === null) return;
    this.openDraft(EditorDraft.newDraft(projectId));
  }

  protected openPipeline(pipeline: Pipeline): void {
    if (this.editing()?.id === pipeline.id) return;
    const projectId = this.projectId();
    if (projectId === null) return;
    this.openDraft(EditorDraft.fromPipeline(projectId, pipeline));
  }

  private openDraft(draft: EditorDraft): void {
    this.attemptedSave.set(false);
    this.editing.set(draft);
    this.selectedStepId.set(null);
    this.editorTab.set('steps');
    this.menuOpen.set(false);
    this.paletteAnchor.set(null);
    this.nodeMenuFor.set(null);
  }

  protected closeEditor(): void {
    this.cancel();
  }

  protected cancel(): void {
    this.attemptedSave.set(false);
    this.editing.set(null);
    this.selectedStepId.set(null);
    this.menuOpen.set(false);
    this.paletteAnchor.set(null);
    this.nodeMenuFor.set(null);
  }

  // ---- Tabs ----

  protected selectTab(tab: 'steps' | 'settings'): void {
    this.editorTab.set(tab);
    this.menuOpen.set(false);
    this.paletteAnchor.set(null);
    this.nodeMenuFor.set(null);
  }

  // ---- Header ----

  protected updateName(name: string): void {
    this.update((draft) => draft.withName(name));
  }

  protected toggleMenu(): void {
    this.menuOpen.update((open) => !open);
  }

  /** Any document click outside the popovers closes them. */
  protected onDocumentClick(): void {
    if (this.menuOpen()) this.menuOpen.set(false);
    if (this.paletteAnchor() !== null) this.paletteAnchor.set(null);
    if (this.nodeMenuFor() !== null) this.nodeMenuFor.set(null);
  }

  // ---- Node selection ----

  protected selectStep(index: number): void {
    this.selectedStepId.set(this.editing()?.steps[index]?.id ?? null);
    this.inspectorTab.set('general');
  }

  private selectStepById(id: string): void {
    this.selectedStepId.set(id);
  }

  // ---- Step (node) mutations ----

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

  // ---- Settings tab ----

  protected updateCategory(category: string): void {
    this.update((draft) => draft.withCategory(category));
  }

  /** The saved pipeline behind the draft (absent for a fresh one). */
  protected readonly savedPipeline = computed(
    () => this.list().find((pipeline) => pipeline.id === this.editing()?.id),
  );

  protected readonly definitionStats = computed<readonly DefinitionStat[]>(() => {
    const draft = this.editing();
    if (draft === null) return [];
    const saved = this.savedPipeline();
    return [
      { label: 'id', value: draft.id === '' ? 'new' : draft.id },
      { label: 'revision', value: saved === undefined ? '—' : String(saved.revision) },
      { label: 'lanes', value: String(draft.steps.filter((step) => step.boardVisible || step.terminal).length) },
      { label: 'steps', value: String(draft.steps.filter((step) => !step.terminal).length) },
    ];
  });

  // ---- Save / delete ----

  protected async save(): Promise<void> {
    const current = this.editing();
    if (current === null) return;
    this.attemptedSave.set(true);
    if (current.validate() !== null) {
      this.editing.set(current.with({ rejection: null }));
      return;
    }
    const outcome = await this.pipelines.save(current.projectId, current.toPipeline());
    if (!outcome.ok) {
      const latest = this.editing();
      if (latest !== null) {
        this.editing.set(latest.with({ rejection: this.pipelines.rejection() ?? 'the server rejected the pipeline' }));
      }
      return;
    }
    // Stay in the editor; a fresh draft adopts the allocated id so a second
    // save updates instead of duplicating.
    const latest = this.editing();
    if (latest !== null && latest.id === '' && outcome.pipelineId !== undefined) {
      this.editing.set(latest.with({ id: outcome.pipelineId, rejection: null }));
    }
    this.attemptedSave.set(false);
  }

  /** Deletes the pipeline being edited (the overflow menu and danger zone). */
  protected async deleteEditing(): Promise<void> {
    const current = this.editing();
    if (current === null || current.id === '') return;
    this.menuOpen.set(false);
    const confirmed = await this.confirm.confirm({
      title: 'Delete this pipeline?',
      detail: 'Assigned cards block the deletion; reassign them first.',
      confirmLabel: 'delete',
      danger: true,
    });
    if (!confirmed) return;
    const removed = await this.pipelines.remove(current.projectId, current.id);
    if (removed) this.cancel();
  }

  private update(fn: (draft: EditorDraft) => EditorDraft): void {
    const current = this.editing();
    if (current === null) return;
    this.editing.set(fn(current));
  }
}
