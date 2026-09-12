// The saved diagram (Phase 11): the canvas's application-flow drawing. Node
// types are semantic (screen/process/decision/note) — the editor derives
// shape, icon, and color from the type as presentation defaults. A diagram
// owns its representation — the wire shape conversions (which also migrate
// legacy V0 payloads) — while the service (canvas/diagram.service.ts) folds
// events and publishes saves. Content is database truth: nodes, edges,
// groups, and the viewport ride the `diagramSaved` event.

import {
  DiagramEdgeJson,
  DiagramGroupJson,
  DiagramJson,
  DiagramNodeJson,
} from '../events/wire';

export type DiagramNodeType = 'screen' | 'process' | 'decision' | 'note';

export const DIAGRAM_NODE_TYPES: readonly DiagramNodeType[] = [
  'screen',
  'process',
  'decision',
  'note',
];

export interface DiagramNodeData {
  readonly id: string;
  readonly type: DiagramNodeType;
  readonly label: string;
  readonly description: string;
  readonly groupId: string | null;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface DiagramEdgeData {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label: string;
}

export interface DiagramGroupData {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface DiagramViewportData {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

/** A node's rendered size (explicit so the canvas and the server agree). */
export function nodeSize(
  label: string,
  type: DiagramNodeType,
): { w: number; h: number } {
  if (type === 'decision') return decisionSize(label);
  const width = Math.max(
    96,
    Math.ceil((measureLabelWidth(label) + NODE_LABEL_CHROME) / 0.88) + 4,
  );
  return { w: width, h: type === 'note' ? 64 : 46 };
}

/** Decision frame height (the rhombus spans it edge to edge). */
const DECISION_HEIGHT = 76;
/** The vertical band the label pill occupies around the middle. */
const DECISION_PILL_BAND = 30;
/** Pill chrome around the label: padding 16 + icon 13 + gap 5. */
const NODE_LABEL_CHROME = 34;
/** The label's rendered font (matches .node-label). */
const NODE_LABEL_FONT = '500 12px Inter, ui-sans-serif, system-ui, sans-serif';

let labelMeasureContext: CanvasRenderingContext2D | null | undefined;

/**
 * The rendered width of a node label — canvas text metrics with the node
 * font, so frames fit their content instead of a per-char estimate.
 */
function measureLabelWidth(label: string): number {
  if (label === '') return 0;
  if (labelMeasureContext === undefined) {
    try {
      labelMeasureContext = document.createElement('canvas').getContext('2d');
    } catch {
      labelMeasureContext = null;
    }
  }
  const context = labelMeasureContext;
  if (!context) return label.length * 7;
  context.font = NODE_LABEL_FONT;
  return context.measureText(label).width;
}

/**
 * A decision's rhombus spans the full frame, so it narrows toward the top
 * and bottom: the label (centered, DECISION_PILL_BAND tall) needs a frame
 * wide enough that the shape is still behind the pill at its edges.
 */
function decisionSize(label: string): { w: number; h: number } {
  const pill = measureLabelWidth(label) + NODE_LABEL_CHROME;
  const width = Math.ceil(
    (pill / (1 - DECISION_PILL_BAND / DECISION_HEIGHT)) * 1.08,
  );
  return { w: Math.max(160, width), h: DECISION_HEIGHT };
}

/** Grows frames whose label no longer fits; never shrinks saved layouts. */
export function fitNodeLabels(
  nodes: readonly DiagramNodeData[],
): DiagramNodeData[] {
  return nodes.map((node) => {
    const size = nodeSize(node.label, node.type);
    return size.w > node.w || size.h > node.h
      ? { ...node, w: Math.max(node.w, size.w), h: Math.max(node.h, size.h) }
      : node;
  });
}

/** The next free single-letter id (A … Z, A1, B1 …) among existing nodes. */
export function nextNodeId(existing: readonly string[]): string {
  const taken = new Set(existing);
  for (let round = 0; round < 100; round += 1) {
    const suffix = round === 0 ? '' : String(round);
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const candidate = `${letter}${suffix}`;
      if (!taken.has(candidate)) return candidate;
    }
  }
  return `N${Date.now()}`;
}

/** The next free group id (G1, G2 …) among existing groups. */
export function nextGroupId(existing: readonly string[]): string {
  const taken = new Set(existing);
  for (let n = 1; n < 1000; n += 1) {
    const candidate = `G${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `G${Date.now()}`;
}

/** The deterministic fallback connection id (matches the server's rule). */
export function deterministicEdgeId(from: string, to: string): string {
  return `e-${from}-${to}`;
}

/** Unknown or absent type reads as note (the legacy-payload migration). */
export function normalizeNodeType(value: unknown): DiagramNodeType {
  return DIAGRAM_NODE_TYPES.includes(value as DiagramNodeType)
    ? (value as DiagramNodeType)
    : 'note';
}

/** One saved diagram the canvas draws. Immutable. */
export class Diagram {
  constructor(readonly data: DiagramData) {}

  get id(): string {
    return this.data.id;
  }

  get name(): string {
    return this.data.name;
  }

  get nodes(): readonly DiagramNodeData[] {
    return this.data.nodes;
  }

  get edges(): readonly DiagramEdgeData[] {
    return this.data.edges;
  }

  get groups(): readonly DiagramGroupData[] {
    return this.data.groups;
  }

  get viewport(): DiagramViewportData | null {
    return this.data.viewport;
  }

  get updatedAt(): string {
    return this.data.updatedAt ?? '';
  }

  with(changes: Partial<DiagramData>): Diagram {
    return new Diagram({ ...this.data, ...changes });
  }

  toWire(): DiagramJson {
    return {
      id: this.data.id,
      name: this.data.name,
      nodes: this.data.nodes.map(toNodeWire),
      edges: this.data.edges.map(toEdgeWire),
      groups: this.data.groups.map((group) => ({ ...group })),
      viewport: this.data.viewport ? { ...this.data.viewport } : null,
      updatedAt: '',
    };
  }

  static fromWire(json: DiagramJson): Diagram {
    return new Diagram({
      id: json.id ?? '',
      name: json.name ?? '',
      nodes: (json.nodes ?? []).map(fromNodeWire),
      edges: (json.edges ?? []).map(fromEdgeWire),
      groups: (json.groups ?? []).map(fromGroupWire),
      viewport: json.viewport ?? null,
      updatedAt: json.updatedAt ?? '',
    });
  }

  /**
   * The field-order-insensitive content signature (the dirty compare).
   * Nodes normalize through the label fit, so a load's grow-only frame
   * correction never reads as an unsaved edit.
   */
  signature(): string {
    return diagramContentSignature(this.data.name, this.data.nodes, this.data.edges, this.data.groups);
  }
}

/** The field-order-insensitive content signature the dirty compare uses. */
export function diagramContentSignature(
  name: string,
  nodes: readonly DiagramNodeData[],
  edges: readonly DiagramEdgeData[],
  groups: readonly DiagramGroupData[],
): string {
  return JSON.stringify([
    name,
    signatures(fitNodeLabels(nodes), nodeSignature),
    signatures(edges, edgeSignature),
    signatures(groups, groupSignature),
  ]);
}

/** Field-order-insensitive content signature for one item list. */
function signatures<T>(items: readonly T[], signature: (item: T) => string): string {
  return JSON.stringify(items.map(signature).sort());
}

function nodeSignature(node: DiagramNodeData): string {
  return JSON.stringify([
    node.id,
    node.type,
    node.label,
    node.description,
    node.groupId,
    node.x,
    node.y,
    node.w,
    node.h,
  ]);
}

function edgeSignature(edge: DiagramEdgeData): string {
  return JSON.stringify([edge.from, edge.to, edge.label]);
}

function groupSignature(group: DiagramGroupData): string {
  return JSON.stringify([group.id, group.label, group.x, group.y, group.w, group.h]);
}

// ---- Graph primitives (the two editors share these) ----

/** The `${node}:source` connector id foblex binds. */
export function connectorSourceId(nodeId: string): string {
  return `${nodeId}:source`;
}

/** The `${node}:target` connector id foblex binds. */
export function connectorTargetId(nodeId: string): string {
  return `${nodeId}:target`;
}

/** The node id behind a foblex connector id (`A:source` → `A`). */
export function nodeIdFromConnector(id: string): string {
  return id.replace(/:(?:source|target)$/, '');
}

/** The topmost group whose frame contains the point (a node created there joins it). */
export function groupIdContaining(
  groups: readonly DiagramGroupData[],
  x: number,
  y: number,
): string | null {
  return (
    groups.find(
      (group) =>
        x >= group.x && x <= group.x + group.w && y >= group.y && y <= group.y + group.h,
    )?.id ?? null
  );
}

/** Whether a frame at (x, y, w, h) covers any node (pad = breathing room). */
export function overlapsAny(
  nodes: readonly DiagramNodeData[],
  x: number,
  y: number,
  w: number,
  h: number,
  pad = 12,
): boolean {
  return nodes.some(
    (node) =>
      x < node.x + node.w + pad &&
      x + w + pad > node.x &&
      y < node.y + node.h + pad &&
      y + h + pad > node.y,
  );
}

/**
 * A fresh node's spot: from `base`, cascading diagonally until the frame
 * covers no existing node (a finite walk, then the base as-is).
 */
export function freshNodeSpot(
  nodes: readonly DiagramNodeData[],
  base: { x: number; y: number },
  size: { w: number; h: number },
  cascade = 32,
  steps = 24,
): { x: number; y: number } {
  for (let step = 0; step < steps; step += 1) {
    const x = base.x + step * cascade;
    const y = base.y + step * cascade;
    if (!overlapsAny(nodes, x, y, size.w, size.h)) {
      return { x: Math.round(x), y: Math.round(y) };
    }
  }
  return { x: Math.round(base.x), y: Math.round(base.y) };
}

/** Whether an edge already runs from→to (the duplicate-connection guard). */
export function edgeExists(
  edges: readonly DiagramEdgeData[],
  from: string,
  to: string,
): boolean {
  return edges.some((edge) => edge.from === from && edge.to === to);
}

/** The selected nodes' bounding box (no padding; the editors add their own). */
export function nodesBounds(nodes: readonly DiagramNodeData[]): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} | null {
  if (nodes.length === 0) return null;
  return {
    left: Math.min(...nodes.map((node) => node.x)),
    top: Math.min(...nodes.map((node) => node.y)),
    right: Math.max(...nodes.map((node) => node.x + node.w)),
    bottom: Math.max(...nodes.map((node) => node.y + node.h)),
  };
}

/**
 * The move rule: positioned nodes land at their targets (a node dragged
 * out of its group's frame leaves the group — never when the group itself
 * moved, since foblex reports the children's final positions too); a moved
 * group drags its contained nodes by the same delta.
 */
export function applyNodeMoves(
  nodes: readonly DiagramNodeData[],
  groups: readonly DiagramGroupData[],
  positions: ReadonlyMap<string, { x: number; y: number }>,
  movedGroupIds: ReadonlySet<string>,
): DiagramNodeData[] {
  return nodes.map((node) => {
    const own = positions.get(node.id);
    if (own !== undefined) {
      let moved = { ...node, x: own.x, y: own.y };
      if (moved.groupId !== null && !movedGroupIds.has(moved.groupId)) {
        const group = groups.find((candidate) => candidate.id === moved.groupId);
        const cx = own.x + node.w / 2;
        const cy = own.y + node.h / 2;
        const inside =
          group !== undefined &&
          cx >= group.x &&
          cx <= group.x + group.w &&
          cy >= group.y &&
          cy <= group.y + group.h;
        if (!inside) moved = { ...moved, groupId: null };
      }
      return moved;
    }
    if (node.groupId === null || !movedGroupIds.has(node.groupId)) return node;
    const group = groups.find((candidate) => candidate.id === node.groupId);
    const target = group === undefined ? undefined : positions.get(group.id);
    if (group === undefined || target === undefined) return node;
    return {
      ...node,
      x: node.x + (target.x - group.x),
      y: node.y + (target.y - group.y),
    };
  });
}

export interface DiagramData {
  readonly id: string;
  readonly name: string;
  readonly nodes: readonly DiagramNodeData[];
  readonly edges: readonly DiagramEdgeData[];
  readonly groups: readonly DiagramGroupData[];
  readonly viewport: DiagramViewportData | null;
  /** Server-stamped last-save time (list ordering + row subtitle). */
  readonly updatedAt?: string;
}

function toNodeWire(node: DiagramNodeData): DiagramNodeJson {
  return {
    id: node.id,
    type: node.type,
    label: node.label,
    description: node.description,
    groupId: node.groupId,
    x: node.x,
    y: node.y,
    w: node.w,
    h: node.h,
  };
}

function fromNodeWire(node: DiagramNodeJson): DiagramNodeData {
  return {
    id: node.id,
    type: normalizeNodeType(node.type),
    label: typeof node.label === 'string' ? node.label : '',
    description: typeof node.description === 'string' ? node.description : '',
    groupId: typeof node.groupId === 'string' && node.groupId !== '' ? node.groupId : null,
    x: typeof node.x === 'number' ? node.x : 0,
    y: typeof node.y === 'number' ? node.y : 0,
    w: typeof node.w === 'number' ? node.w : 96,
    h: typeof node.h === 'number' ? node.h : 46,
  };
}

function fromGroupWire(group: DiagramGroupJson): DiagramGroupData {
  return {
    id: group.id,
    label: typeof group.label === 'string' ? group.label : '',
    x: typeof group.x === 'number' ? group.x : 0,
    y: typeof group.y === 'number' ? group.y : 0,
    w: typeof group.w === 'number' ? group.w : 200,
    h: typeof group.h === 'number' ? group.h : 150,
  };
}

function toEdgeWire(edge: DiagramEdgeData): DiagramEdgeJson {
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    ...(edge.label !== '' ? { label: edge.label } : {}),
  };
}

function fromEdgeWire(edge: DiagramEdgeJson): DiagramEdgeData {
  const from = edge.from;
  const to = edge.to;
  return {
    id: typeof edge.id === 'string' && edge.id !== '' ? edge.id : deterministicEdgeId(from, to),
    from,
    to,
    label: typeof edge.label === 'string' ? edge.label : '',
  };
}
