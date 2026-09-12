import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from "@angular/core";
import {
  EFMarkerType,
  FCanvasComponent,
  FCreateConnectionEvent,
  FDeleteSelectedEvent,
  FDropToGroupEvent,
  FFlowComponent,
  FFlowModule,
  FMoveNodesEvent,
  FSelectionChangeEvent,
  provideFFlow,
  withA11y,
} from "@foblex/flow";
import {
  Cog,
  FilePlus,
  GitFork,
  Monitor,
  Save,
  Square,
  StickyNote,
  Trash2,
  LucideAngularModule,
} from "lucide-angular";

import { ConfirmService } from "../core/confirm/confirm.service";
import { ageLabel } from "../core/age";
import {
  DIAGRAM_NODE_TYPES,
  Diagram,
  DiagramEdgeData,
  DiagramGroupData,
  DiagramNodeData,
  DiagramNodeType,
  DiagramViewportData,
  connectorSourceId,
  connectorTargetId,
  nodeIdFromConnector,
  nodeSize,
} from "../core/models/diagram.models";
import {
  DiagramDraft,
  TYPE_START_LABEL,
} from "../core/models/diagram-draft";
import { ShellService } from "../shell/shell.service";
import { routedProjectId } from "../shell/route-project-id";
import { DiagramService } from "./diagram.service";

/** The starter name a new diagram opens with. */
const UNTITLED = "Untitled";

/** The zoom buttons' bounds (matches the foblex wheel-zoom clamps). */
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.2;

/** How long a pan/zoom burst waits before the viewport-only save flies. */
const VIEWPORT_SAVE_DEBOUNCE_MS = 600;

/** The right-click creation menu's state (viewport position + canvas point). */
interface ContextMenuState {
  x: number;
  y: number;
  canvasX: number;
  canvasY: number;
}

type DetailPanelState =
  | { kind: "node"; node: DiagramNodeData }
  | { kind: "edge"; edge: DiagramEdgeData }
  | { kind: "group"; group: DiagramGroupData }
  | { kind: "multi"; count: number };

/**
 * The canvas view (Phase 11): the project's saved application-flow diagrams
 * over @foblex/flow. Node types are semantic (screen/process/decision/note);
 * shape, icon, and color are presentation defaults derived from the type.
 * Diagrams are database truth: the service folds events, the canvas edits
 * publish saves, and panning persists through a debounced viewport-only
 * command that never trips the unsaved-changes guard.
 */
@Component({
  selector: "app-canvas",
  changeDetection: ChangeDetectionStrategy.OnPush,
  // withA11y turns on the keyboard layer: Delete/Backspace delete the
  // selection (fDeleteSelected below), Escape deselects, Ctrl+A selects all,
  // and +/-/0 zoom — the pointer gestures stay as they were.
  providers: [provideFFlow(withA11y())],
  // Enter/Space open the selected node's panel, Ctrl/Cmd+G groups the
  // selection, Escape closes the context menu, any click closes it too.
  host: {
    "(document:keydown)": "handleKeydown($event)",
    "(document:click)": "closeContextMenu()",
  },
  imports: [FFlowModule, LucideAngularModule],
  templateUrl: "./canvas.component.html",
  styleUrl: "./canvas.component.scss",
})
export class CanvasComponent {
  private readonly diagrams = inject(DiagramService);
  private readonly shell = inject(ShellService);
  private readonly confirm = inject(ConfirmService);

  protected readonly icons = {
    newDiagram: FilePlus,
    save: Save,
    delete: Trash2,
    screen: Monitor,
    process: Cog,
    decision: GitFork,
    note: StickyNote,
    group: Square,
  };
  protected readonly nodeTypes = DIAGRAM_NODE_TYPES;
  protected readonly markerEnd = EFMarkerType.END;

  protected readonly rejection = this.diagrams.rejection;
  // This instance always serves one project (the tab reuse strategy keys
  // instances by project) — a stable id, not the active tab's.
  protected readonly projectId = computed(() => this.myProjectId || (this.shell.activeTabId() ?? ""));
  private readonly myProjectId = routedProjectId();
  protected readonly list = computed(() => this.diagrams.diagramsOf(this.projectId()));

  protected readonly selectedId = signal<string | null>(null);

  // The editor's live working copy: a DiagramDraft owns the graph and its
  // mutation rules; the template reads these projections.
  private readonly draft = signal(DiagramDraft.blank(UNTITLED));
  protected readonly name = computed(() => this.draft().name);
  protected readonly nodes = computed(() => this.draft().nodes);
  protected readonly edges = computed(() => this.draft().edges);
  protected readonly groups = computed(() => this.draft().groups);

  protected readonly selectedNodeIds = signal<string[]>([]);
  protected readonly selectedGroupIds = signal<string[]>([]);
  protected readonly selectedEdgeId = signal<string | null>(null);

  // The persisted viewport (pan + zoom), bound to the foblex canvas.
  protected readonly viewport = signal<DiagramViewportData>({ x: 0, y: 0, scale: 1 });

  protected readonly contextMenu = signal<ContextMenuState | null>(null);
  protected readonly editingEdgeId = signal<string | null>(null);
  protected readonly edgeDraft = signal("");
  protected readonly edgeEditorPos = signal<{ x: number; y: number } | null>(null);

  protected readonly selectedNode = computed(
    () =>
      this.nodes().find((node) => node.id === this.selectedNodeIds()[0]) ??
      null,
  );
  protected readonly selectedEdge = computed(
    () => this.edges().find((edge) => edge.id === this.selectedEdgeId()) ?? null,
  );
  protected readonly selectedGroup = computed(
    () =>
      this.groups().find((group) => group.id === this.selectedGroupIds()[0]) ??
      null,
  );

  /** What the detail pane shows for the current selection. */
  protected readonly panel = computed<DetailPanelState | null>(() => {
    if (this.selectedNodeIds().length > 1) {
      return { kind: "multi", count: this.selectedNodeIds().length };
    }
    if (this.selectedNode()) return { kind: "node", node: this.selectedNode()! };
    if (this.selectedEdge()) return { kind: "edge", edge: this.selectedEdge()! };
    if (this.selectedGroup()) return { kind: "group", group: this.selectedGroup()! };
    return null;
  });

  protected readonly selected = computed(
    () =>
      this.list().find((diagram) => diagram.id === this.selectedId()) ?? null,
  );

  /**
   * Whether the working copy differs from the saved diagram (the draft's
   * signature compare; the viewport is excluded — it flows through the
   * viewport-only save).
   */
  protected readonly dirty = computed(() => this.draft().dirtyAgainst(this.selected()));

  protected readonly saveDisabled = computed(() => !this.dirty());

  private readonly flow = viewChild(FFlowComponent);
  private readonly canvas = viewChild(FCanvasComponent);
  private readonly titleInput = viewChild<ElementRef<HTMLInputElement>>("titleInput");
  private readonly edgeLabelInput =
    viewChild<ElementRef<HTMLInputElement>>("edgeLabelInput");
  private readonly drawingArea = viewChild<ElementRef<HTMLElement>>("drawingArea");

  /** The id whose working copy the editor currently holds (echoes excluded). */
  private loadedId: string | null = null;
  /** Deferred work (selection sync, fitting) dies with the view. */
  private destroyed = false;
  private viewportTimer: ReturnType<typeof setTimeout> | null = null;
  /** The viewport awaiting its debounced save, and the diagram it belongs to. */
  private pendingViewport: DiagramViewportData | null = null;
  private pendingViewportDiagramId: string | null = null;

  /** Watches the drawing area so pan survives window/inspector resizes. */
  private areaObserver: ResizeObserver | null = null;
  /** The last seen drawing-area size (null until the first callback). */
  private lastAreaSize: { w: number; h: number } | null = null;
  /** Guard: resizes landing right after a diagram load are layout settling. */
  private lastLoadedAt = 0;

  /** Bumped while nodes drag so the floating detail pane re-anchors. */
  private readonly paneReflow = signal(0);
  /** The floating detail pane's width (matches .detail-panel). */
  private static readonly PANE_WIDTH = 288;
  /** Rough cap used to vertically center the pane on its anchor. */
  private static readonly PANE_HEIGHT_ESTIMATE = 340;

  /**
   * Where the floating detail pane sits: next to the selected node (or
   * group/edge anchor), falling to the node's other side and finally on
   * top of it when the drawing area has no room.
   */
  protected readonly panelAnchor = computed(() => {
    this.paneReflow(); // re-anchor while dragging
    const flow = this.flow();
    const drawingArea = this.drawingArea()?.nativeElement;
    const panel = this.panel();
    if (!flow || !drawingArea || panel === null) {
      return { left: 0, top: 0, width: CanvasComponent.PANE_WIDTH };
    }
    const flowRect = flow.hostElement.getBoundingClientRect();
    const areaRect = drawingArea.getBoundingClientRect();
    const viewport = this.viewport();
    const anchor = this.panelAnchorRect(panel);
    const pad = 8;
    const paneW = Math.min(
      CanvasComponent.PANE_WIDTH,
      Math.max(0, flowRect.width - pad * 2),
    );
    const flowLeft = flowRect.left - areaRect.left;
    const flowTop = flowRect.top - areaRect.top;
    const nodeRight = flowLeft + viewport.x + (anchor.x + anchor.w) * viewport.scale;
    const nodeLeft = flowLeft + viewport.x + anchor.x * viewport.scale;
    const nextRight = nodeRight + pad;
    const rightBound = flowLeft + flowRect.width - pad;
    const fitsRight = nextRight + paneW <= rightBound;
    const nextLeft = nodeLeft - paneW - pad;
    const left = fitsRight
      ? Math.max(flowLeft + pad, Math.min(nextRight, rightBound - paneW))
      : Math.max(flowLeft + pad, Math.min(nextLeft, rightBound - paneW));
    const paneH = CanvasComponent.PANE_HEIGHT_ESTIMATE;
    const centerY =
      flowTop + viewport.y + (anchor.y + anchor.h / 2) * viewport.scale;
    const top = Math.max(
      flowTop + pad,
      Math.min(centerY - paneH / 2, flowTop + flowRect.height - paneH - pad),
    );
    return {
      left: Math.round(left),
      top: Math.round(top),
      width: Math.round(paneW),
    };
  });

  protected zoomPercent(): number {
    return Math.round(this.viewport().scale * 100);
  }

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.flushViewport();
      this.areaObserver?.disconnect();
      this.areaObserver = null;
    });

    // Anchor pan to the drawing area's size: when the area resizes (window
    // resize, inspector opening), shift the pan by half the delta so the
    // content's center stays put instead of drifting off-screen.
    effect(() => {
      const flow = this.flow();
      if (flow) this.observeArea(flow.hostElement);
    });

    // Webfonts land after the first load's measurements ran — refit once
    // they do so frames computed against the fallback font still grow.
    document.fonts?.ready.then(() => {
      if (!this.destroyed && this.loadedId !== null) this.refitNodeLabels();
    });

    // Selecting a diagram loads its working copy — once per id. Save echoes
    // fold the same diagram back over the wire and must never wipe the
    // working copy (edits made while the request flew would be lost).
    effect(() => {
      const id = this.selectedId();
      const diagram = this.selected();
      if (id === null) {
        this.loadedId = null;
        this.clearEditor();
        return;
      }
      if (this.loadedId === id) {
        // Already editing it. If the fold dropped it entirely, the diagram
        // was deleted (here or from another tab) — close the editor.
        if (diagram === null) this.selectedId.set(null);
        return;
      }
      if (diagram === null) {
        // Not folded yet (a fresh create awaiting its echo) — blank the
        // editor so the previous diagram doesn't linger.
        this.clearEditor();
        return;
      }
      this.flushViewport();
      this.loadedId = id;
      this.lastLoadedAt = performance.now();
      // Saved frames predate text measurement — the draft grows the cramped
      // ones so labels are never truncated (grow-only: never reshuffle).
      this.draft.set(DiagramDraft.open(diagram));
      this.clearSelection();
      this.contextMenu.set(null);
      this.editingEdgeId.set(null);
      if (diagram.viewport) {
        // Restore the last viewport for this diagram.
        this.viewport.set({ ...diagram.viewport });
        this.pendingViewport = { ...diagram.viewport };
        this.pendingViewportDiagramId = id;
        // The saved viewport was sized for a possibly different drawing
        // area; if it now points the content off-screen, recover with a
        // fit instead of showing an apparently-empty canvas.
        this.afterRender(() => this.ensureContentVisible());
      } else {
        // Diagrams without a stored viewport fit their content on open.
        this.viewport.set({ x: 0, y: 0, scale: 1 });
        this.pendingViewport = null;
        this.pendingViewportDiagramId = null;
        this.fitToScreen();
      }
    });

  }

  protected async selectDiagram(id: string | null): Promise<void> {
    if (this.selectedId() === id) return;
    if (this.dirty() && !(await this.confirmDiscard())) return;
    this.selectedId.set(id);
  }

  protected async createDiagram(): Promise<void> {
    if (this.dirty() && !(await this.confirmDiscard())) return;
    const result = await this.diagrams.save(
      this.projectId(),
      DiagramDraft.blank(UNTITLED).toDiagram("", { x: 0, y: 0, scale: 1 }, UNTITLED),
    );
    if (result.ok && result.diagramId !== undefined) {
      this.selectedId.set(result.diagramId);
    }
  }

  protected async saveDiagram(): Promise<void> {
    const projectId = this.projectId();
    const id = this.selectedId();
    if (!projectId || id === null) return;
    await this.diagrams.save(projectId, this.draft().toDiagram(id, this.viewport(), UNTITLED));
  }

  protected async deleteDiagram(): Promise<void> {
    const id = this.selectedId();
    if (id === null) return;
    const ok = await this.confirm.confirm({
      title: "Delete this diagram?",
      detail: "the diagram is removed from the database",
      confirmLabel: "delete",
      danger: true,
    });
    if (!ok) return;
    await this.diagrams.remove(this.projectId(), id);
    this.selectedId.set(null);
  }

  protected rename(value: string): void {
    this.draft.update((draft) => draft.rename(value));
  }

  // ---- Node creation (toolbar + the right-click menu) ----

  protected addNode(): void {
    this.draft.set(this.draft().addNodeNear("note", this.viewportCenterBase()).draft);
  }

  /** The context-menu actions: the item lands at the converted point. */
  protected createAt(menu: ContextMenuState, type: DiagramNodeType | "group"): void {
    this.contextMenu.set(null);
    if (type === "group") {
      this.createGroupAt(menu.canvasX, menu.canvasY);
      return;
    }
    const size = nodeSize(TYPE_START_LABEL[type], type);
    this.addNodeAt(type, {
      x: Math.round(menu.canvasX - size.w / 2),
      y: Math.round(menu.canvasY - size.h / 2),
    });
  }

  private addNodeAt(type: DiagramNodeType, spot: { x: number; y: number }): void {
    const added = this.draft().addNode(type, spot);
    this.draft.set(added.draft);
    this.selectNode(added.nodeId);
    this.editNodeLabel();
  }

  /** An empty group from the context menu (or Ctrl+G for a formed one). */
  private createGroupAt(x: number, y: number): void {
    const created = this.draft().addGroupAt(x, y);
    this.draft.set(created.draft);
    this.selectedNodeIds.set([]);
    this.selectedEdgeId.set(null);
    this.selectedGroupIds.set([created.groupId]);
    this.editGroupLabel();
  }

  // ---- Selection + gesture handlers ----

  protected selectionChanged(event: FSelectionChangeEvent): void {
    this.selectedNodeIds.set(event.nodeIds);
    this.selectedGroupIds.set(event.groupIds);
    const connectionId = event.connectionIds[0];
    this.selectedEdgeId.set(connectionId === undefined ? null : connectionId);
  }

  protected moveNodes(event: FMoveNodesEvent): void {
    this.paneReflow.update((n) => n + 1); // keep the floating pane anchored
    const positions = new Map(event.nodes.map((item) => [item.id, item.position]));
    const movedGroupIds = new Set(
      event.nodes.map((item) => item.id).filter((id) => this.groups().some((g) => g.id === id)),
    );
    this.draft.update((draft) => draft.moveNodes(positions, movedGroupIds));
  }

  protected groupResized(
    id: string,
    rect: { x: number; y: number; width: number; height: number },
  ): void {
    this.draft.update((draft) => draft.resizeGroup(id, rect));
  }

  /** Dropping nodes over a group joins it (foblex's drop-to-group). */
  protected dropToGroup(event: FDropToGroupEvent): void {
    this.draft.update((draft) => draft.dropToGroup(event.nodeIds, event.targetGroupId));
  }

  protected createConnection(event: FCreateConnectionEvent): void {
    if (event.targetId === undefined) return;
    const from = nodeIdFromConnector(event.sourceId);
    const to = nodeIdFromConnector(event.targetId);
    const created = this.draft().connect(from, to);
    if (created.edgeId === null) return;
    const edgeId = created.edgeId;
    this.draft.set(created.draft);
    this.selectedNodeIds.set([]);
    this.selectedGroupIds.set([]);
    this.selectedEdgeId.set(edgeId);
    // The connection element doesn't exist yet (foblex emits before render);
    // sync the visual selection once it does.
    this.afterRender(() => this.flow()?.select([], [edgeId], true));
  }

  // ---- The detail panel's edits ----

  protected relabel(value: string): void {
    this.updateSelectedNode((draft, id) => draft.setNodeLabel(id, value));
  }

  protected retype(type: DiagramNodeType): void {
    this.updateSelectedNode((draft, id) => draft.setNodeType(id, type));
  }

  protected redescribe(description: string): void {
    this.updateSelectedNode((draft, id) => draft.setNodeDescription(id, description));
  }

  protected regroupLabel(label: string): void {
    const id = this.selectedGroupIds()[0];
    if (id === undefined) return;
    this.draft.update((draft) => draft.setGroupLabel(id, label));
  }

  protected relabelEdge(value: string): void {
    const id = this.selectedEdgeId();
    if (id === null) return;
    this.draft.update((draft) => draft.setEdgeLabel(id, value));
  }

  protected deleteSelectedNode(): void {
    const ids = this.selectedNodeIds();
    if (ids.length === 0) return;
    this.draft.update((draft) => draft.deleteNodes(ids));
    this.clearSelection();
  }

  protected deleteSelectedEdge(): void {
    const id = this.selectedEdgeId();
    if (id === null) return;
    this.draft.update((draft) => draft.deleteEdge(id));
    this.clearSelection();
  }

  /** Deleting a group preserves its nodes; only membership goes away. */
  protected deleteSelectedGroup(): void {
    const ids = this.selectedGroupIds();
    if (ids.length === 0) return;
    this.draft.update((draft) => draft.deleteGroups(ids));
    this.clearSelection();
  }

  /** Ctrl/Cmd+G: a group forms around the selected nodes' bounding box. */
  protected groupSelection(): void {
    const created = this.draft().groupSelection(this.selectedNodeIds());
    if (created.groupId === null) return;
    this.draft.set(created.draft);
  }

  /** The keyboard layer's delete (Delete/Backspace with a selection). */
  protected deleteSelected(event: FDeleteSelectedEvent): void {
    this.draft.update((draft) =>
      draft.deleteSelection({
        nodeIds: event.nodeIds,
        groupIds: event.groupIds,
        edgeIds: event.connectionIds,
      }),
    );
    this.clearSelection();
  }

  // ---- Inline connector-label editing ----

  /** Begins an inline edit; the editor floats above the canvas (unclipped). */
  protected startEditEdge(id: string, label: string, event?: MouseEvent): void {
    this.editingEdgeId.set(id);
    this.edgeDraft.set(label);
    if (event) {
      const host = this.drawingArea()?.nativeElement;
      const target = event.target as HTMLElement;
      if (host && target) {
        const area = host.getBoundingClientRect();
        const rect = target.getBoundingClientRect();
        this.edgeEditorPos.set({
          x: rect.left - area.left + rect.width / 2,
          y: rect.top - area.top,
        });
      }
    }
    this.afterRender(() => this.edgeLabelInput()?.nativeElement.focus());
  }

  /** Enter commits (so does blur); Escape cancels. */
  protected commitEdgeLabel(): void {
    const id = this.editingEdgeId();
    if (id === null) return;
    this.editingEdgeId.set(null);
    const value = this.edgeDraft().trim();
    this.draft.update((draft) => draft.setEdgeLabel(id, value));
  }

  protected cancelEdgeLabel(): void {
    this.editingEdgeId.set(null);
  }

  // ---- Viewport (zoom controls + debounced persistence) ----

  protected zoomIn(): void {
    this.zoomBy(1);
  }

  protected zoomOut(): void {
    this.zoomBy(-1);
  }

  protected zoomReset(): void {
    // ResetScale alone only zeroes the zoom (pan stays wherever it was);
    // recenter so 1:1 always puts the content back in view. The change
    // event must fire (foblex's default) — the [position]/[scale] bindings
    // re-apply the viewport signal on every CD pass, so a silent reset
    // would be overwritten by the stale scale on the next tick.
    if (this.nodes().length === 0) {
      const canvas = this.canvas();
      canvas?.resetScale();
      canvas?.emitCanvasChangeEvent();
      return;
    }
    this.canvas()?.resetScaleAndCenter(false);
  }

  protected fitToScreen(): void {
    if (this.nodes().length === 0) return;
    const canvas = this.canvas();
    if (!canvas) return;
    canvas.fitToScreen({ x: 48, y: 48 }, false);
    // Fitting small content would blow past 100%; only zoom OUT to fit,
    // otherwise just center it (the standard editor behavior). The fit
    // lands after a deferred redraw, so the clamp must read the settled
    // scale — synchronously getScale() still reports the pre-fit value.
    this.afterRender(() => {
      if (canvas.getScale() > 1) canvas.resetScaleAndCenter(false);
    });
  }

  /**
   * Pan/zoom landed: mirror the viewport for the input bindings and schedule
   * the debounced viewport-only save, so panning never triggers the
   * unsaved-content warning.
   */
  protected canvasChanged(event: { position: { x: number; y: number }; scale: number }): void {
    this.viewport.set({
      x: Math.round(event.position.x),
      y: Math.round(event.position.y),
      scale: event.scale,
    });
    this.scheduleViewportSave();
  }

  /** Schedules the debounced viewport-only save for the current state. */
  private scheduleViewportSave(): void {
    if (this.loadedId === null) return;
    this.pendingViewport = this.viewport();
    this.pendingViewportDiagramId = this.loadedId;
    if (this.viewportTimer !== null) clearTimeout(this.viewportTimer);
    this.viewportTimer = setTimeout(() => this.flushViewport(), VIEWPORT_SAVE_DEBOUNCE_MS);
  }

  /** Publishes the pending viewport save (the debounce's flush). */
  private flushViewport(): void {
    if (this.viewportTimer !== null) {
      clearTimeout(this.viewportTimer);
      this.viewportTimer = null;
    }
    const diagramId = this.pendingViewportDiagramId;
    const viewport = this.pendingViewport;
    this.pendingViewportDiagramId = null;
    this.pendingViewport = null;
    if (diagramId === null || viewport === null) return;
    const projectId = this.projectId();
    if (!projectId || this.destroyed) return;
    void this.diagrams.saveViewport(projectId, diagramId, viewport);
  }

  protected editNodeLabel(): void {
    if (this.selectedNode() === null) return;
    this.afterRender(() => this.titleInput()?.nativeElement.focus());
  }

  protected editGroupLabel(): void {
    if (this.selectedGroup() === null) return;
    this.afterRender(() => this.titleInput()?.nativeElement.focus());
  }

  /** Enter or Space opens the selected node; Ctrl/Cmd+G groups. */
  protected handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      this.contextMenu.set(null);
      return;
    }
    if ((event.key === "g" || event.key === "G") && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.groupSelection();
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && this.selectedNode() !== null) {
      const target = event.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT"
      ) {
        return;
      }
      event.preventDefault();
      this.editNodeLabel();
    }
  }

  // ---- The right-click creation menu ----

  protected openContextMenu(event: MouseEvent): void {
    if (!this.selectedId()) return;
    // The browser menu has no place on the drawing surface. Nodes, labels,
    // and group chrome keep their own behavior (drag / inline edit); the
    // empty canvas AND a group's open interior open the creation menu —
    // a node created over a group joins it (the point lands inside).
    event.preventDefault();
    const target = event.target as HTMLElement | null;
    if (target?.closest?.(".flow-node, .edge-label, .group-resize, .group-title")) {
      return;
    }
    const host = this.flow()?.hostElement;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const point = this.flow()?.getPositionInFlow({ x: event.clientX, y: event.clientY }) ?? {
      x: 0,
      y: 0,
    };
    // Keep the menu inside the drawing area: shift it left/up when the
    // pointer is close to the right or bottom edge.
    const menuW = 158; // .context-menu min-width + borders
    const menuH = 165; // 5 items + separator, measured height
    const x = Math.max(0, Math.min(event.clientX - rect.left, rect.width - menuW));
    const y = Math.max(0, Math.min(event.clientY - rect.top, rect.height - menuH));
    this.contextMenu.set({
      x,
      y,
      canvasX: point.x,
      canvasY: point.y,
    });
  }

  /** Any left click closes the menu (item actions run first, then this). */
  protected closeContextMenu(): void {
    if (this.contextMenu() !== null) this.contextMenu.set(null);
  }

  /** The route guard's hook: leaving with unsaved work asks first. */
  async confirmLeave(): Promise<boolean> {
    return await this.confirmDiscard();
  }

  /** The list row's secondary line: relative last-save time. */
  protected diagramStamp(diagram: Diagram): string {
    const raw = diagram.updatedAt;
    if (raw === '') return "";
    const at = new Date(raw);
    if (Number.isNaN(at.getTime())) return "";
    return ageLabel(at);
  }

  // ---- Helpers ----

  protected readonly sourceId = connectorSourceId;

  protected readonly targetId = connectorTargetId;

  /**
   * A fresh node lands near the viewport center (the occupied-spot cascade
   * lives in the draft — `addNodeNear`).
   */
  private viewportCenterBase(): { x: number; y: number } {
    const size = nodeSize(TYPE_START_LABEL["note"], "note");
    const flow = this.flow();
    if (!flow) return { x: 60, y: 60 };
    const rect = flow.hostElement.getBoundingClientRect();
    const center = flow.getPositionInFlow({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
    return { x: center.x - size.w / 2, y: center.y - size.h / 2 };
  }

  private zoomBy(direction: 1 | -1): void {
    const canvas = this.canvas();
    const flow = this.flow();
    if (!canvas || !flow) return;
    const next =
      direction > 0
        ? Math.min(ZOOM_MAX, canvas.getScale() + ZOOM_STEP)
        : Math.max(ZOOM_MIN, canvas.getScale() - ZOOM_STEP);
    // setScale only mutates the transform model — without an explicit
    // redraw + change event nothing re-renders and the readout stays
    // stale (foblex's wheel path does this same trio in SetZoom).
    canvas.setScale(Number(next.toFixed(2)), this.flowCenter(flow));
    canvas.redraw();
    canvas.emitCanvasChangeEvent();
  }

  /** The flow-space point currently at the center of the drawing area. */
  private flowCenter(flow: FFlowComponent): { x: number; y: number } {
    const rect = flow.hostElement.getBoundingClientRect();
    const point = flow.getPositionInFlow({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
    return { x: point.x, y: point.y };
  }

  /**
   * Grows the working copy's frames whose label no longer fits (one-way;
   * the fonts-ready refit lands here — the load fold grew in the draft).
   */
  private refitNodeLabels(): void {
    this.draft.update((draft) => draft.fitLabels());
  }

  // ---- Drawing-area resize adaptation ----

  private observeArea(host: HTMLElement): void {
    if (this.areaObserver === null) {
      this.areaObserver = new ResizeObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (entry) {
          this.onAreaResized({
            w: entry.contentRect.width,
            h: entry.contentRect.height,
          });
        }
      });
    }
    // Re-observing a new element restarts the baseline.
    this.areaObserver.disconnect();
    this.lastAreaSize = null;
    this.areaObserver.observe(host);
  }

  private onAreaResized(size: { w: number; h: number }): void {
    const last = this.lastAreaSize;
    this.lastAreaSize = size;
    this.paneReflow.update((n) => n + 1);
    if (last === null || this.destroyed) return;
    const dx = size.w - last.w;
    const dy = size.h - last.h;
    if (dx === 0 && dy === 0) return;
    // Right after a diagram load the toolbar/layout is still settling —
    // that delta belongs to the load, not to the user's window.
    if (performance.now() - this.lastLoadedAt < 300) return;
    if (this.loadedId === null) return;
    // Keep the content's center anchored: the area resized around its
    // middle, so shift the pan by half the delta.
    this.viewport.update((v) => ({
      x: Math.round(v.x + dx / 2),
      y: Math.round(v.y + dy / 2),
      scale: v.scale,
    }));
    this.scheduleViewportSave();
  }

  /**
   * Recovers a restored viewport that points the content entirely outside
   * the drawing area (saved at a different window size) by fitting instead.
   */
  private ensureContentVisible(): void {
    const flow = this.flow();
    if (!flow || this.nodes().length === 0) return;
    const rect = flow.hostElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const viewport = this.viewport();
    const box = this.contentBox();
    const left = rect.left + viewport.x + box.minX * viewport.scale;
    const top = rect.top + viewport.y + box.minY * viewport.scale;
    const right = left + (box.maxX - box.minX) * viewport.scale;
    const bottom = top + (box.maxY - box.minY) * viewport.scale;
    if (right < rect.left || left > rect.right || bottom < rect.top || top > rect.bottom) {
      this.fitToScreen();
    }
  }

  /** The flow-space bounding box the detail pane anchors to. */
  private panelAnchorRect(
    panel: DetailPanelState,
  ): { x: number; y: number; w: number; h: number } {
    const fallback = { x: 0, y: 0, w: 100, h: 46 };
    if (panel.kind === "node") return this.selectedNode() ?? fallback;
    if (panel.kind === "edge") {
      return (
        this.nodes().find((node) => node.id === panel.edge.from) ?? fallback
      );
    }
    if (panel.kind === "group") {
      return this.selectedGroup() ?? { x: 0, y: 0, w: 200, h: 120 };
    }
    // multi: union of the selected frames
    const keys = new Set(this.selectedNodeIds());
    const picked = this.nodes().filter((node) => keys.has(node.id));
    if (picked.length === 0) return fallback;
    const minX = Math.min(...picked.map((node) => node.x));
    const minY = Math.min(...picked.map((node) => node.y));
    const maxX = Math.max(...picked.map((node) => node.x + node.w));
    const maxY = Math.max(...picked.map((node) => node.y + node.h));
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  /** Flow-space bounding box of everything drawn (nodes + groups). */
  private contentBox(): { minX: number; minY: number; maxX: number; maxY: number } {
    const items: { x: number; y: number; w: number; h: number }[] = [
      ...this.nodes(),
      ...this.groups(),
    ];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const item of items) {
      minX = Math.min(minX, item.x);
      minY = Math.min(minY, item.y);
      maxX = Math.max(maxX, item.x + item.w);
      maxY = Math.max(maxY, item.y + item.h);
    }
    return { minX, minY, maxX, maxY };
  }

  /** Runs work once the DOM (nodes, connections) has rendered and settled. */
  private afterRender(fn: () => void): void {
    requestAnimationFrame(() => {
      if (this.destroyed) return;
      requestAnimationFrame(() => {
        if (!this.destroyed) fn();
      });
    });
  }

  private selectNode(id: string): void {
    this.selectedNodeIds.set([id]);
    this.selectedGroupIds.set([]);
    this.selectedEdgeId.set(null);
    // Tell foblex so the ring, keyboard layer and background-click clearing
    // agree with the local state (deferred until the node element exists).
    this.afterRender(() => this.flow()?.select([id], [], true));
  }

  /** Applies a draft mutation to the first selected node. */
  private updateSelectedNode(
    update: (draft: DiagramDraft, id: string) => DiagramDraft,
  ): void {
    const id = this.selectedNodeIds()[0];
    if (id === undefined) return;
    this.draft.update((draft) => update(draft, id));
  }

  private clearSelection(): void {
    this.selectedNodeIds.set([]);
    this.selectedGroupIds.set([]);
    this.selectedEdgeId.set(null);
    this.flow()?.clearSelection();
  }

  private clearEditor(): void {
    this.draft.set(DiagramDraft.blank(UNTITLED));
    this.clearSelection();
  }

  private async confirmDiscard(): Promise<boolean> {
    if (!this.dirty()) return true;
    return await this.confirm.confirm({
      title: "Discard unsaved changes?",
      detail: "the diagram has edits that were not saved yet",
      confirmLabel: "discard",
      danger: true,
    });
  }
}
