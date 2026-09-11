// The saved diagram (Phase 11): the canvas's free-form drawing — typed
// nodes with geometry and descriptions, labeled edges between them, named
// groups, and a persisted viewport. Dual representation (`fromWire`/
// `toWire()`) around an immutable instance; the fold replaces instances as
// `diagramSaved`/`diagramViewportChanged` events land. The content rides
// the events and lives in the event log (the diagrams' database), not in a
// file.

import type {
  Diagram as DiagramJson,
  DiagramEdge,
  DiagramGroup,
  DiagramNode,
  DiagramNodeType,
  DiagramViewport,
} from '../wire/models.js';
import { CommandRejection } from './rejection.js';

/** The number of nodes/edges/groups one diagram may carry (canvas-sized). */
export const MAX_DIAGRAM_NODES = 256;
export const MAX_DIAGRAM_EDGES = 1024;
export const MAX_DIAGRAM_GROUPS = 64;

/** The semantic node types (shape/icon/color are presentation defaults). */
export const DIAGRAM_NODE_TYPES: readonly DiagramNodeType[] = [
  'screen',
  'process',
  'decision',
  'note',
];

export class Diagram {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly nodes: readonly DiagramNode[];
  readonly edges: readonly DiagramEdge[];
  readonly groups: readonly DiagramGroup[];
  readonly viewport: DiagramViewport | null;
  readonly updatedAt: string;

  constructor(json: DiagramJson) {
    this.id = json.id;
    this.projectId = json.projectId;
    this.name = json.name;
    this.nodes = json.nodes.map((node) => ({ ...node }));
    this.edges = json.edges.map((edge) => ({ ...edge }));
    this.groups = (json.groups ?? []).map((group) => ({ ...group }));
    this.viewport = json.viewport ? { ...json.viewport } : null;
    this.updatedAt = json.updatedAt;
  }

  static fromWire(json: DiagramJson): Diagram {
    return new Diagram(json);
  }

  /** The same diagram carrying a new viewport (the viewport-only save). */
  withViewport(viewport: DiagramViewport): Diagram {
    return Diagram.fromWire({ ...this.toWire(), viewport: { ...viewport } });
  }

  toWire(): DiagramJson {
    return {
      id: this.id,
      projectId: this.projectId,
      name: this.name,
      nodes: this.nodes.map((node) => ({ ...node })),
      edges: this.edges.map((edge) => ({ ...edge })),
      groups: this.groups.map((group) => ({ ...group })),
      viewport: this.viewport ? { ...this.viewport } : null,
      updatedAt: this.updatedAt,
    };
  }
}

/**
 * Validates and normalizes a save's payload, returning the trimmed name.
 * The diagram's id must be non-empty (the processor allocates the id before
 * this call, so a blank id here is a client error); nodes need unique
 * non-empty ids and finite geometry, and every edge must reference nodes
 * that exist.
 */
export function validateDiagramName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') throw new CommandRejection('invalidCommand', 'Diagram name is required');
  return trimmed;
}

/** A save's content after normalization (everything except ids/timestamps). */
export interface NormalizedDiagramContent {
  name: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups: DiagramGroup[];
}

/**
 * Normalizes and validates a save's payload: legacy fields fill in
 * (type → 'note', groups → [], deterministic edge ids), unknown types and
 * dangling references reject. Returns the fully-normalized content so the
 * stored diagram is always explicit (for later LLM consumption).
 */
export function normalizeDiagram(diagram: DiagramJson): NormalizedDiagramContent {
  const name = validateDiagramName(diagram.name);
  const rejection = (message: string): CommandRejection =>
    new CommandRejection('invalidCommand', message);

  if (diagram.nodes.length > MAX_DIAGRAM_NODES) {
    throw rejection(`Diagram has ${diagram.nodes.length} nodes; the limit is ${MAX_DIAGRAM_NODES}`);
  }
  if (diagram.edges.length > MAX_DIAGRAM_EDGES) {
    throw rejection(`Diagram has ${diagram.edges.length} edges; the limit is ${MAX_DIAGRAM_EDGES}`);
  }
  if ((diagram.groups ?? []).length > MAX_DIAGRAM_GROUPS) {
    throw rejection(
      `Diagram has ${(diagram.groups ?? []).length} groups; the limit is ${MAX_DIAGRAM_GROUPS}`,
    );
  }

  const nodes: DiagramNode[] = diagram.nodes.map((node, index) => {
    const id = typeof node.id === 'string' ? node.id.trim() : '';
    if (id === '') throw rejection(`Node ${index + 1} needs an id`);
    const type = node.type ?? 'note';
    if (!DIAGRAM_NODE_TYPES.includes(type)) {
      throw rejection(`Node '${id}' has an unknown type '${String(type)}'`);
    }
    for (const key of ['x', 'y', 'w', 'h'] as const) {
      if (!Number.isFinite(node[key])) throw rejection(`Node '${id}' has an invalid ${key}`);
    }
    if (node.w < 1 || node.h < 1) throw rejection(`Node '${id}' needs a positive size`);
    return {
      id,
      type,
      label: typeof node.label === 'string' ? node.label : '',
      description: typeof node.description === 'string' ? node.description : '',
      groupId: node.groupId ? node.groupId : null,
      x: node.x,
      y: node.y,
      w: node.w,
      h: node.h,
    };
  });

  const groups: DiagramGroup[] = (diagram.groups ?? []).map((group, index) => {
    const id = typeof group.id === 'string' ? group.id.trim() : '';
    if (id === '') throw rejection(`Group ${index + 1} needs an id`);
    for (const key of ['x', 'y', 'w', 'h'] as const) {
      if (!Number.isFinite(group[key])) throw rejection(`Group '${id}' has an invalid ${key}`);
    }
    if (group.w < 1 || group.h < 1) throw rejection(`Group '${id}' needs a positive size`);
    return {
      id,
      label: typeof group.label === 'string' ? group.label : '',
      x: group.x,
      y: group.y,
      w: group.w,
      h: group.h,
    };
  });

  const nodeIds = new Set(nodes.map((node) => node.id));
  const groupIds = new Set(groups.map((group) => group.id));

  for (const node of nodes) {
    if (node.groupId && !groupIds.has(node.groupId)) {
      throw rejection(`Node '${node.id}': unknown group '${node.groupId}'`);
    }
  }

  const edges: DiagramEdge[] = diagram.edges.map((edge, index) => {
    const from = typeof edge.from === 'string' ? edge.from : '';
    const to = typeof edge.to === 'string' ? edge.to : '';
    if (!nodeIds.has(from)) throw rejection(`Edge ${index + 1}: unknown node '${from}'`);
    if (!nodeIds.has(to)) throw rejection(`Edge ${index + 1}: unknown node '${to}'`);
    const id = (edge.id ?? '').trim() !== '' ? edge.id!.trim() : `e-${from}-${to}`;
    return {
      id,
      from,
      to,
      label: typeof edge.label === 'string' ? edge.label : '',
    };
  });

  // Duplicate node pairs would collide on the deterministic edge id.
  const edgeIds = new Set<string>();
  const pairs = new Set<string>();
  for (const edge of edges) {
    const id = edge.id ?? '';
    if (edgeIds.has(id)) throw rejection(`Edge id '${id}' appears twice`);
    edgeIds.add(id);
    const pair = `${edge.from}->${edge.to}`;
    if (pairs.has(pair)) {
      throw rejection(`Edge from '${edge.from}' to '${edge.to}' appears twice`);
    }
    pairs.add(pair);
  }

  return { name, nodes, edges, groups };
}

/**
 * Whether a save would change the definition (name, nodes, edges, or
 * groups). The viewport is excluded — it flows through the viewport-only
 * save and must never make a content save a no-op (or vice versa).
 */
export function sameDiagram(current: Diagram, next: NormalizedDiagramContent): boolean {
  return (
    current.name === next.name &&
    JSON.stringify(current.nodes) === JSON.stringify(next.nodes) &&
    JSON.stringify(current.edges) === JSON.stringify(next.edges) &&
    JSON.stringify(current.groups) === JSON.stringify(next.groups)
  );
}

/** Whether the viewport is well-formed (finite pan, positive scale). */
export function isValidViewport(viewport: DiagramViewport): boolean {
  return (
    Number.isFinite(viewport.x) &&
    Number.isFinite(viewport.y) &&
    Number.isFinite(viewport.scale) &&
    viewport.scale > 0
  );
}

/** Whether two viewports describe the same pan/zoom. */
export function sameViewport(a: DiagramViewport | null, b: DiagramViewport): boolean {
  return a !== null && a.x === b.x && a.y === b.y && a.scale === b.scale;
}
