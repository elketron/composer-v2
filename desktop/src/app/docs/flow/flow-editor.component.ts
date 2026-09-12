import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from "@angular/core";
import {
  EFMarkerType,
  FCreateConnectionEvent,
  FDropToGroupEvent,
  FFlowModule,
  FMoveNodesEvent,
  FSelectionChangeEvent,
} from "@foblex/flow";

import { connectorSourceId, connectorTargetId, nextNodeId, nodeIdFromConnector } from "../../core/models/diagram.models";
import {
  FlowEdge,
  FlowDirection,
  FlowGroup,
  FlowNode,
  FlowParseError,
  FlowShape,
  nodeSize,
  parseFlow,
  serializeFlow,
} from "./flow-graph";

@Component({
  selector: "app-flow-editor",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FFlowModule],
  templateUrl: "./flow-editor.component.html",
  styleUrl: "./flow-editor.component.scss",
})
export class FlowEditorComponent {
  readonly code = input.required<string>();
  readonly codeChange = output<string>();

  protected readonly nodes = signal<FlowNode[]>([]);
  protected readonly edges = signal<FlowEdge[]>([]);
  protected readonly groups = signal<FlowGroup[]>([]);
  protected readonly parseError = signal<string | null>(null);

  protected readonly selectedNodeIds = signal<string[]>([]);
  protected readonly selectedGroupId = signal<string | null>(null);
  protected readonly selectedEdgeIndex = signal<number>(-1);
  protected readonly selected = computed(
    () =>
      this.nodes().find((node) => node.id === this.selectedNodeIds()[0]) ??
      null,
  );
  protected readonly selectedGroup = computed(
    () =>
      this.groups().find((group) => group.id === this.selectedGroupId()) ??
      null,
  );
  protected readonly selectedEdge = computed(
    () => this.edges()[this.selectedEdgeIndex()] ?? null,
  );
  protected readonly markerEnd = EFMarkerType.END;

  private direction: FlowDirection = "TD";
  private lastEmitted: string | null = null;
  private emitQueued = false;

  constructor() {
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
      this.groups.set(graph.groups);
      this.direction = graph.direction;
      this.parseError.set(null);
      this.clearSelection();
    } catch (error) {
      const message =
        error instanceof FlowParseError
          ? error.message
          : `diagram parse failed: ${String(error)}`;
      this.parseError.set(message);
    }
  }

  protected addNode(): void {
    const id = nextNodeId([
      ...this.nodes().map((node) => node.id),
      ...this.groups().map((group) => group.id),
    ]);
    const label = "New";
    this.nodes.update((current) => [
      ...current,
      {
        id,
        label,
        type: "",
        description: "",
        groupId: null,
        shape: "rect",
        x: 60 + ((current.length * 48) % 240),
        y: 60 + ((current.length * 48) % 160),
        ...nodeSize(label, "rect"),
      },
    ]);
    this.selectedNodeIds.set([id]);
    this.selectedGroupId.set(null);
    this.selectedEdgeIndex.set(-1);
    this.emit();
  }

  protected addGroup(): void {
    const id = this.nextGroupId();
    const children = this.nodes().filter((node) =>
      this.selectedNodeIds().includes(node.id),
    );
    const fallback = 40 + ((this.groups().length * 36) % 180);
    const left =
      children.length > 0
        ? Math.min(...children.map((node) => node.x)) - 28
        : fallback;
    const top =
      children.length > 0
        ? Math.min(...children.map((node) => node.y)) - 48
        : fallback;
    const right =
      children.length > 0
        ? Math.max(...children.map((node) => node.x + node.w)) + 28
        : left + 320;
    const bottom =
      children.length > 0
        ? Math.max(...children.map((node) => node.y + node.h)) + 28
        : top + 200;
    this.groups.update((current) => [
      ...current,
      { id, label: "Group", x: left, y: top, w: right - left, h: bottom - top },
    ]);
    if (children.length > 0) {
      const childIds = new Set(children.map((node) => node.id));
      this.nodes.update((current) =>
        current.map((node) =>
          childIds.has(node.id) ? { ...node, groupId: id } : node,
        ),
      );
    }
    this.selectedNodeIds.set([]);
    this.selectedGroupId.set(id);
    this.selectedEdgeIndex.set(-1);
    this.emit();
  }

  protected selectionChanged(event: FSelectionChangeEvent): void {
    this.selectedNodeIds.set(event.nodeIds);
    this.selectedGroupId.set(event.groupIds[0] ?? null);
    const connectionId = event.connectionIds[0];
    this.selectedEdgeIndex.set(
      connectionId === undefined ? -1 : this.edgeIndex(connectionId),
    );
  }

  protected moveItems(event: FMoveNodesEvent): void {
    const positions = new Map(
      event.nodes.map((item) => [item.id, item.position]),
    );
    this.nodes.update((current) =>
      current.map((node) => {
        const position = positions.get(node.id);
        return position === undefined
          ? node
          : { ...node, x: position.x, y: position.y };
      }),
    );
    this.groups.update((current) =>
      current.map((group) => {
        const position = positions.get(group.id);
        return position === undefined
          ? group
          : { ...group, x: position.x, y: position.y };
      }),
    );
    this.emit();
  }

  protected groupResized(
    id: string,
    rect: { x: number; y: number; width: number; height: number },
  ): void {
    this.groups.update((current) =>
      current.map((group) =>
        group.id === id
          ? { ...group, x: rect.x, y: rect.y, w: rect.width, h: rect.height }
          : group,
      ),
    );
    this.emit();
  }

  protected droppedToGroup(event: FDropToGroupEvent): void {
    const ids = new Set(event.nodeIds);
    this.nodes.update((current) =>
      current.map((node) =>
        ids.has(node.id) ? { ...node, groupId: event.targetGroupId } : node,
      ),
    );
    this.emit();
  }

  protected createConnection(event: FCreateConnectionEvent): void {
    if (event.targetId === undefined) return;
    const from = nodeIdFromConnector(event.sourceId);
    const to = nodeIdFromConnector(event.targetId);
    if (
      from === to ||
      !this.nodes().some((node) => node.id === from) ||
      !this.nodes().some((node) => node.id === to)
    )
      return;
    if (this.edges().some((edge) => edge.from === from && edge.to === to))
      return;
    this.edges.update((current) => [...current, { from, to, label: "" }]);
    this.selectedNodeIds.set([]);
    this.selectedGroupId.set(null);
    this.selectedEdgeIndex.set(this.edges().length - 1);
    this.emit();
  }

  protected relabel(value: string): void {
    this.updateSelectedNode((node) => ({
      ...node,
      label: value,
      ...nodeSize(value, node.shape),
    }));
  }

  protected setType(value: string): void {
    this.updateSelectedNode((node) => ({ ...node, type: value }));
  }

  protected setDescription(value: string): void {
    this.updateSelectedNode((node) => ({ ...node, description: value }));
  }

  protected reshape(shape: FlowShape): void {
    this.updateSelectedNode((node) => ({
      ...node,
      shape,
      ...nodeSize(node.label, shape),
    }));
  }

  protected relabelEdge(value: string): void {
    const index = this.selectedEdgeIndex();
    if (index < 0) return;
    this.edges.update((current) =>
      current.map((edge, edgeIndex) =>
        edgeIndex === index ? { ...edge, label: value } : edge,
      ),
    );
    this.emit();
  }

  protected relabelGroup(value: string): void {
    const id = this.selectedGroupId();
    if (id === null) return;
    this.groups.update((current) =>
      current.map((group) =>
        group.id === id ? { ...group, label: value } : group,
      ),
    );
    this.emit();
  }

  protected deleteSelectedNode(): void {
    const ids = new Set(this.selectedNodeIds());
    if (ids.size === 0) return;
    this.nodes.update((current) => current.filter((node) => !ids.has(node.id)));
    this.edges.update((current) =>
      current.filter((edge) => !ids.has(edge.from) && !ids.has(edge.to)),
    );
    this.clearSelection();
    this.emit();
  }

  protected deleteSelectedEdge(): void {
    const index = this.selectedEdgeIndex();
    if (index < 0) return;
    this.edges.update((current) =>
      current.filter((_, edgeIndex) => edgeIndex !== index),
    );
    this.clearSelection();
    this.emit();
  }

  protected deleteSelectedGroup(): void {
    const id = this.selectedGroupId();
    if (id === null) return;
    this.groups.update((current) => current.filter((group) => group.id !== id));
    this.nodes.update((current) =>
      current.map((node) =>
        node.groupId === id ? { ...node, groupId: null } : node,
      ),
    );
    this.clearSelection();
    this.emit();
  }

  protected ungroupSelectedNodes(): void {
    const ids = new Set(this.selectedNodeIds());
    this.nodes.update((current) =>
      current.map((node) =>
        ids.has(node.id) ? { ...node, groupId: null } : node,
      ),
    );
    this.emit();
  }

  protected edgeId(index: number): string {
    return `edge-${index}`;
  }

  protected readonly sourceId = connectorSourceId;

  protected readonly targetId = connectorTargetId;

  private updateSelectedNode(update: (node: FlowNode) => FlowNode): void {
    const id = this.selectedNodeIds()[0];
    if (id === undefined) return;
    this.nodes.update((current) =>
      current.map((node) => (node.id === id ? update(node) : node)),
    );
    this.emit();
  }

  private clearSelection(): void {
    this.selectedNodeIds.set([]);
    this.selectedGroupId.set(null);
    this.selectedEdgeIndex.set(-1);
  }

  private edgeIndex(id: string): number {
    const index = Number(id.replace(/^edge-/, ""));
    return Number.isInteger(index) ? index : -1;
  }


  private nextGroupId(): string {
    const ids = new Set([
      ...this.nodes().map((node) => node.id),
      ...this.groups().map((group) => group.id),
    ]);
    for (let index = 1; index < 10_000; index += 1) {
      const candidate = `Group${index}`;
      if (!ids.has(candidate)) return candidate;
    }
    return `Group${Date.now()}`;
  }

  private emit(): void {
    if (this.emitQueued) return;
    this.emitQueued = true;
    queueMicrotask(() => {
      this.emitQueued = false;
      const serialized = serializeFlow({
        direction: this.direction,
        nodes: this.nodes(),
        edges: this.edges(),
        groups: this.groups(),
      });
      this.lastEmitted = serialized;
      this.codeChange.emit(serialized);
    });
  }
}
