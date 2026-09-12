// The canvas/flow working copy (FNT-016): one diagram being edited — the
// graph state plus every mutation rule (creation, membership on drag and
// drop, duplicate-edge guard, cascade deletes, group formation). Mirrors
// `EditorDraft`/`DocEditSession`: the components call it and commit the
// result through `DiagramService`; the dirty compare is the draft's own
// field-order-insensitive signature against the saved diagram (the
// viewport is excluded — it flows through the viewport-only save).

import {
  Diagram,
  DiagramEdgeData,
  DiagramGroupData,
  DiagramNodeData,
  DiagramNodeType,
  DiagramViewportData,
  applyNodeMoves,
  deterministicEdgeId,
  diagramContentSignature,
  edgeExists,
  fitNodeLabels,
  freshNodeSpot,
  groupIdContaining,
  nextGroupId,
  nextNodeId,
  nodeSize,
  nodesBounds,
} from './diagram.models';

/** The starter labels (the user renames via the detail panel). */
export const TYPE_START_LABEL: Record<DiagramNodeType, string> = {
  screen: 'Screen',
  process: 'Process',
  decision: 'Decision',
  note: 'Note',
};

export class DiagramDraft {
  private constructor(
    readonly name: string,
    readonly nodes: readonly DiagramNodeData[],
    readonly edges: readonly DiagramEdgeData[],
    readonly groups: readonly DiagramGroupData[],
  ) {}

  /** An empty working copy (a brand-new diagram). */
  static blank(name: string): DiagramDraft {
    return new DiagramDraft(name, [], [], []);
  }

  /**
   * Opens a saved diagram: the working copy's frames grow to fit their
   * labels (saved frames predate text measurement — grow-only, never
   * reshuffling a layout).
   */
  static open(saved: Diagram): DiagramDraft {
    return new DiagramDraft(
      saved.name,
      fitNodeLabels(saved.nodes.map((node) => ({ ...node }))),
      saved.edges.map((edge) => ({ ...edge })),
      saved.groups.map((group) => ({ ...group })),
    );
  }

  rename(name: string): DiagramDraft {
    return new DiagramDraft(name, this.nodes, this.edges, this.groups);
  }

  /** The node by id. */
  node(id: string): DiagramNodeData | null {
    return this.nodes.find((node) => node.id === id) ?? null;
  }

  /** The edge by id. */
  edge(id: string): DiagramEdgeData | null {
    return this.edges.find((edge) => edge.id === id) ?? null;
  }

  /** The group by id. */
  group(id: string): DiagramGroupData | null {
    return this.groups.find((group) => group.id === id) ?? null;
  }

  // ---- Creation ----

  /**
   * Adds a node of `type` at `spot` (its top-left); a node created over a
   * group joins it. Returns the draft and the new node's id.
   */
  addNode(
    type: DiagramNodeType,
    spot: { x: number; y: number },
  ): { draft: DiagramDraft; nodeId: string } {
    const id = nextNodeId(this.nodes.map((node) => node.id));
    const label = TYPE_START_LABEL[type];
    const groupId = groupIdContaining(this.groups, spot.x, spot.y);
    const node: DiagramNodeData = {
      id,
      type,
      label,
      description: '',
      groupId,
      x: spot.x,
      y: spot.y,
      ...nodeSize(label, type),
    };
    return { draft: this.withNodes([...this.nodes, node]), nodeId: id };
  }

  /** An empty group centered on the point (240×160). */
  addGroupAt(x: number, y: number): { draft: DiagramDraft; groupId: string } {
    const w = 240;
    const h = 160;
    const id = nextGroupId(this.groups.map((group) => group.id));
    const group: DiagramGroupData = {
      id,
      label: 'Group',
      x: Math.round(x - w / 2),
      y: Math.round(y - h / 2),
      w,
      h,
    };
    return { draft: this.withGroups([...this.groups, group]), groupId: id };
  }

  /** Ctrl/Cmd+G: a group forms around the selected nodes' bounding box. */
  groupSelection(selectedIds: readonly string[]): { draft: DiagramDraft; groupId: string | null } {
    const selected = this.nodes.filter((node) => selectedIds.includes(node.id));
    const bounds = nodesBounds(selected);
    if (bounds === null) return { draft: this, groupId: null };
    const pad = 24;
    const id = nextGroupId(this.groups.map((group) => group.id));
    const group: DiagramGroupData = {
      id,
      label: 'Group',
      x: bounds.left - pad,
      y: bounds.top - pad,
      w: bounds.right - bounds.left + pad * 2,
      h: bounds.bottom - bounds.top + pad * 2,
    };
    const memberIds = new Set(selected.map((node) => node.id));
    return {
      draft: this.withGroups([...this.groups, group]).withNodes(
        this.nodes.map((node) => (memberIds.has(node.id) ? { ...node, groupId: id } : node)),
      ),
      groupId: id,
    };
  }

  /**
   * A node lands near `base` (the viewport center's flow point); occupied
   * spots cascade diagonally until it covers no existing node.
   */
  addNodeNear(
    type: DiagramNodeType,
    base: { x: number; y: number },
  ): { draft: DiagramDraft; nodeId: string } {
    const size = nodeSize(TYPE_START_LABEL[type], type);
    const spot = freshNodeSpot(this.nodes, base, size);
    return this.addNode(type, spot);
  }

  // ---- Gestures ----

  /** The canvas's drag-and-drop move rule (see `applyNodeMoves`). */
  moveNodes(
    positions: ReadonlyMap<string, { x: number; y: number }>,
    movedGroupIds: ReadonlySet<string>,
  ): DiagramDraft {
    return this.withNodes(applyNodeMoves(this.nodes, this.groups, positions, movedGroupIds)).withGroups(
      this.groups.map((group) => {
        const position = positions.get(group.id);
        return position === undefined ? group : { ...group, x: position.x, y: position.y };
      }),
    );
  }

  resizeGroup(
    id: string,
    rect: { x: number; y: number; width: number; height: number },
  ): DiagramDraft {
    return this.withGroups(
      this.groups.map((group) =>
        group.id === id
          ? { ...group, x: rect.x, y: rect.y, w: rect.width, h: rect.height }
          : group,
      ),
    );
  }

  /** Dropping nodes over a group joins it (foblex's drop-to-group). */
  dropToGroup(nodeIds: readonly string[], targetGroupId: string): DiagramDraft {
    const ids = new Set(nodeIds);
    return this.withNodes(
      this.nodes.map((node) =>
        ids.has(node.id) && node.groupId !== targetGroupId
          ? { ...node, groupId: targetGroupId }
          : node,
      ),
    );
  }

  /**
   * A connection between two existing, distinct nodes that doesn't already
   * exist — the canvas's duplicate guard. Null when refused.
   */
  connect(from: string, to: string): { draft: DiagramDraft; edgeId: string | null } {
    if (
      from === to ||
      !this.nodes.some((node) => node.id === from) ||
      !this.nodes.some((node) => node.id === to) ||
      edgeExists(this.edges, from, to)
    ) {
      return { draft: this, edgeId: null };
    }
    const edge: DiagramEdgeData = { id: deterministicEdgeId(from, to), from, to, label: '' };
    return { draft: this.withEdges([...this.edges, edge]), edgeId: edge.id };
  }

  // ---- The detail panel's edits ----

  /** Relabels a node; the frame grows to fit and never shrinks (grow-only, like the load). */
  setNodeLabel(id: string, label: string): DiagramDraft {
    return this.withNodes(
      this.nodes.map((node) => {
        if (node.id !== id) return node;
        const size = nodeSize(label, node.type);
        return { ...node, label, w: Math.max(node.w, size.w), h: Math.max(node.h, size.h) };
      }),
    );
  }

  setNodeType(id: string, type: DiagramNodeType): DiagramDraft {
    return this.withNodes(
      this.nodes.map((node) => {
        if (node.id !== id) return node;
        const size = nodeSize(node.label, type);
        return { ...node, type, w: Math.max(node.w, size.w), h: Math.max(node.h, size.h) };
      }),
    );
  }

  setNodeDescription(id: string, description: string): DiagramDraft {
    return this.withNodes(
      this.nodes.map((node) => (node.id === id ? { ...node, description } : node)),
    );
  }

  setNodeGroup(id: string, groupId: string | null): DiagramDraft {
    return this.withNodes(
      this.nodes.map((node) => (node.id === id ? { ...node, groupId } : node)),
    );
  }

  setGroupLabel(id: string, label: string): DiagramDraft {
    return this.withGroups(
      this.groups.map((group) => (group.id === id ? { ...group, label } : group)),
    );
  }

  setEdgeLabel(id: string, label: string): DiagramDraft {
    return this.withEdges(
      this.edges.map((edge) => (edge.id === id ? { ...edge, label } : edge)),
    );
  }

  // ---- Deletes ----

  /** Nodes leave with their edges (the detail panel's node delete). */
  deleteNodes(ids: readonly string[]): DiagramDraft {
    const gone = new Set(ids);
    return this.withNodes(this.nodes.filter((node) => !gone.has(node.id))).withEdges(
      this.edges.filter((edge) => !gone.has(edge.from) && !gone.has(edge.to)),
    );
  }

  deleteEdge(id: string): DiagramDraft {
    return this.withEdges(this.edges.filter((edge) => edge.id !== id));
  }

  /** Deleting a group preserves its nodes; only membership goes away. */
  deleteGroups(ids: readonly string[]): DiagramDraft {
    const gone = new Set(ids);
    return this.withGroups(this.groups.filter((group) => !gone.has(group.id))).withNodes(
      this.nodes.map((node) =>
        node.groupId !== null && gone.has(node.groupId) ? { ...node, groupId: null } : node,
      ),
    );
  }

  /** The keyboard layer's delete: nodes, groups, and edges in one event. */
  deleteSelection(selection: {
    nodeIds: readonly string[];
    groupIds: readonly string[];
    edgeIds: readonly string[];
  }): DiagramDraft {
    let draft: DiagramDraft = this;
    if (selection.nodeIds.length > 0) draft = draft.deleteNodes(selection.nodeIds);
    if (selection.groupIds.length > 0) draft = draft.deleteGroups(selection.groupIds);
    if (selection.edgeIds.length > 0) {
      const gone = new Set(selection.edgeIds);
      draft = draft.withEdges(draft.edges.filter((edge) => !gone.has(edge.id)));
    }
    return draft;
  }
  // ---- Projection ----

  // ---- Projection ----

  /** Grows frames whose label no longer fits (the webfonts-ready refit; grow-only). */
  fitLabels(): DiagramDraft {
    return this.withNodes(fitNodeLabels(this.nodes));
  }

  /** Whether the working copy differs from the saved diagram (the viewport is not the draft's business). */
  dirtyAgainst(saved: Diagram | null): boolean {
    if (saved === null) return false;
    return diagramContentSignature(this.name, this.nodes, this.edges, this.groups) !== saved.signature();
  }

  /** The saved diagram this working copy becomes (id and viewport ride in). */
  toDiagram(id: string, viewport: DiagramViewportData, fallbackName: string): Diagram {
    return new Diagram({
      id,
      name: this.name.trim() === '' ? fallbackName : this.name,
      nodes: this.nodes.map((node) => ({ ...node })),
      edges: this.edges.map((edge) => ({ ...edge })),
      groups: this.groups.map((group) => ({ ...group })),
      viewport,
    });
  }

  private withNodes(nodes: readonly DiagramNodeData[]): DiagramDraft {
    return new DiagramDraft(this.name, nodes, this.edges, this.groups);
  }

  private withEdges(edges: readonly DiagramEdgeData[]): DiagramDraft {
    return new DiagramDraft(this.name, this.nodes, edges, this.groups);
  }

  private withGroups(groups: readonly DiagramGroupData[]): DiagramDraft {
    return new DiagramDraft(this.name, this.nodes, this.edges, groups);
  }
}
