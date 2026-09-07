import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

import {
  FlowDirection,
  FlowEdge,
  FlowNode,
  FlowParseError,
  FlowShape,
  edgeGeometry,
  nextNodeId,
  nodeSize,
  parseFlow,
  serializeFlow,
} from './flow-graph';

/**
 * The flow editor (Phase 9 S31): a drag-and-drop canvas over the mermaid
 * flowchart subset. The `code` input is the fence's text; every canvas
 * change re-serializes and emits it — two-way with hand edits, positions
 * round-tripping through `%% composer:` comments. A parse failure shows
 * a visible error and leaves the code untouched: the editor refuses what
 * it cannot represent instead of mangling it.
 */
@Component({
  selector: 'app-flow-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './flow-editor.component.html',
  styleUrl: './flow-editor.component.scss',
})
export class FlowEditorComponent {
  /** The fence content this canvas edits. */
  readonly code = input.required<string>();

  /** The re-serialized fence content after any canvas change. */
  readonly codeChange = output<string>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly nodes = signal<FlowNode[]>([]);
  protected readonly edges = signal<FlowEdge[]>([]);
  protected readonly direction = signal<FlowDirection>('TD');
  protected readonly parseError = signal<string | null>(null);

  protected readonly selectedNode = signal<string | null>(null);
  protected readonly selectedEdge = signal<FlowEdge | null>(null);
  protected readonly selectedEdgeIndex = signal<number>(-1);

  /** An in-flight connection: its source and the cursor's canvas point. */
  protected readonly connecting = signal<{ from: string; x: number; y: number } | null>(null);

  protected readonly selected = computed(
    () => this.nodes().find((node) => node.id === this.selectedNode()) ?? null,
  );

  private lastEmitted: string | null = null;
  private drag: { id: string; offsetX: number; offsetY: number; rect: DOMRect } | null = null;
  private emitQueued = false;

  constructor() {
    // Re-parse when the parent feeds different code than what we emitted
    // (hand edits, or the doc's other text changed the fence extraction).
    effect(() => {
      const code = this.code();
      if (code === this.lastEmitted) return;
      this.apply(code);
    });
  }

  private apply(code: string): void {
    try {
      const graph = parseFlow(code);
      this.nodes.set(graph.nodes);
      this.edges.set(graph.edges);
      this.direction.set(graph.direction);
      this.parseError.set(null);
      this.pruneSelection();
    } catch (error) {
      const message =
        error instanceof FlowParseError ? error.message : `diagram parse failed: ${String(error)}`;
      this.parseError.set(message);
    }
  }

  private pruneSelection(): void {
    if (this.selectedNode() !== null && !this.nodes().some((node) => node.id === this.selectedNode())) {
      this.selectedNode.set(null);
    }
    if (this.selectedEdge() !== null && !this.edges().includes(this.selectedEdge()!)) {
      this.selectedEdge.set(null);
      this.selectedEdgeIndex.set(-1);
    }
  }

  // ---- Mutations (each ends in emit) ----

  protected addNode(): void {
    const id = nextNodeId(this.nodes().map((node) => node.id));
    const size = nodeSize('New', 'rect');
    const node: FlowNode = {
      id,
      label: 'New',
      shape: 'rect',
      x: 60 + ((this.nodes().length * 48) % 240),
      y: 60 + ((this.nodes().length * 48) % 160),
      ...size,
    };
    this.nodes.update((current) => [...current, node]);
    this.selectedNode.set(id);
    this.selectedEdge.set(null);
    this.emit();
  }

  protected selectNode(node: FlowNode): void {
    this.selectedNode.set(node.id);
    this.selectedEdge.set(null);
    this.selectedEdgeIndex.set(-1);
  }

  protected selectEdge(event: Event, edge: FlowEdge): void {
    event.stopPropagation();
    this.selectedEdge.set(edge);
    this.selectedEdgeIndex.set(this.edges().indexOf(edge));
    this.selectedNode.set(null);
  }

  protected relabel(value: string): void {
    const id = this.selectedNode();
    if (id === null) return;
    this.nodes.update((current) =>
      current.map((node) => {
        if (node.id !== id) return node;
        const resized = { ...node, label: value, ...nodeSize(value, node.shape) };
        return resized;
      }),
    );
    this.emit();
  }

  protected reshape(shape: FlowShape): void {
    const id = this.selectedNode();
    if (id === null) return;
    this.nodes.update((current) =>
      current.map((node) =>
        node.id === id ? { ...node, shape, ...nodeSize(node.label, shape) } : node,
      ),
    );
    this.emit();
  }

  protected relabelEdge(value: string): void {
    const edge = this.selectedEdge();
    if (edge === null) return;
    this.edges.update((current) =>
      current.map((candidate) =>
        candidate === edge ? { ...candidate, label: value } : candidate,
      ),
    );
    this.emit();
  }

  protected deleteSelectedNode(): void {
    const id = this.selectedNode();
    if (id === null) return;
    this.nodes.update((current) => current.filter((node) => node.id !== id));
    this.edges.update((current) => current.filter((edge) => edge.from !== id && edge.to !== id));
    this.selectedNode.set(null);
    this.emit();
  }

  protected deleteSelectedEdge(): void {
    const edge = this.selectedEdge();
    if (edge === null) return;
    this.edges.update((current) => current.filter((candidate) => candidate !== edge));
    this.selectedEdge.set(null);
    this.selectedEdgeIndex.set(-1);
    this.emit();
  }

  protected clearSelection(): void {
    this.selectedNode.set(null);
    this.selectedEdge.set(null);
    this.selectedEdgeIndex.set(-1);
  }

  // ---- Geometry for the template ----

  protected line(points: { x1: number; y1: number; x2: number; y2: number }): string {
    return `M ${points.x1} ${points.y1} L ${points.x2} ${points.y2}`;
  }

  protected geometry(edge: FlowEdge): { x1: number; y1: number; x2: number; y2: number } | null {
    const from = this.nodes().find((node) => node.id === edge.from);
    const to = this.nodes().find((node) => node.id === edge.to);
    if (from === undefined || to === undefined) return null;
    return edgeGeometry(from, to);
  }

  protected pendingGeometry(): { x1: number; y1: number; x2: number; y2: number } | null {
    const pending = this.connecting();
    if (pending === null) return null;
    const from = this.nodes().find((node) => node.id === pending.from);
    if (from === undefined) return null;
    return edgeGeometry(from, {
      ...from,
      x: pending.x - from.w / 2,
      y: pending.y - from.h / 2,
    });
  }

  // ---- Pointer gestures ----

  protected startDrag(node: FlowNode, event: PointerEvent): void {
    if (this.connecting() !== null) return;
    event.stopPropagation();
    this.selectNode(node);
    const rect = this.canvasRect();
    this.drag = {
      id: node.id,
      offsetX: event.clientX - rect.left - node.x,
      offsetY: event.clientY - rect.top - node.y,
      rect,
    };
    this.capture(event);
  }

  protected startConnect(node: FlowNode, event: PointerEvent): void {
    event.stopPropagation();
    const rect = this.canvasRect();
    this.connecting.set({
      from: node.id,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
    this.capture(event);
  }

  protected onPointerMove(event: PointerEvent): void {
    const pending = this.connecting();
    if (pending !== null) {
      const rect = this.canvasRect();
      this.connecting.set({ ...pending, x: event.clientX - rect.left, y: event.clientY - rect.top });
      return;
    }
    const drag = this.drag;
    if (drag === null) return;
    const x = Math.max(0, event.clientX - drag.rect.left - drag.offsetX);
    const y = Math.max(0, event.clientY - drag.rect.top - drag.offsetY);
    this.nodes.update((current) =>
      current.map((node) => (node.id === drag.id ? { ...node, x, y } : node)),
    );
  }

  protected onPointerUp(event: PointerEvent): void {
    const pending = this.connecting();
    if (pending !== null) {
      this.connecting.set(null);
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>('.flow-node');
      const id = target?.dataset['nodeId'];
      if (id !== undefined && id !== pending.from && this.nodes().some((node) => node.id === id)) {
        this.addEdge(pending.from, id);
      }
      return;
    }
    if (this.drag !== null) {
      this.drag = null;
      this.emit(); // Positions live in the fence comments.
    }
  }

  private addEdge(from: string, to: string): void {
    const exists = this.edges().some((edge) => edge.from === from && edge.to === to);
    if (exists) return;
    this.edges.update((current) => [...current, { from, to, label: '' }]);
    this.selectedEdge.set(this.edges().at(-1)!);
    this.selectedEdgeIndex.set(this.edges().length - 1);
    this.selectedNode.set(null);
    this.emit();
  }

  private capture(event: PointerEvent): void {
    const canvas = this.host.nativeElement.querySelector('.canvas') as HTMLElement | null;
    if (canvas !== null && typeof canvas.setPointerCapture === 'function') {
      canvas.setPointerCapture(event.pointerId);
    }
  }

  private canvasRect(): DOMRect {
    const canvas = this.host.nativeElement.querySelector('.canvas');
    return (canvas as HTMLElement | null)?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0);
  }

  // ---- Emission ----

  private emit(): void {
    if (this.emitQueued) return;
    this.emitQueued = true;
    // Coalesce the update signals of one gesture into one emission.
    queueMicrotask(() => {
      this.emitQueued = false;
      const serialized = serializeFlow({
        direction: this.direction(),
        nodes: this.nodes(),
        edges: this.edges(),
      });
      this.lastEmitted = serialized;
      this.codeChange.emit(serialized);
    });
  }
}
