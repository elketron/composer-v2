// The flow-graph layer (Phase 9 S31): a strict mermaid flowchart subset —
// rect `[a]`, rounded `(a)`, and diamond `{a}` nodes chained with `-->`,
// optionally labeled (`-- text -->`, `-->|text|`) — parsed to a graph and
// serialized back. Manual positions round-trip through `%% composer:`
// comment lines (mermaid ignores comments), so the saved file stays
// plain markdown and hand-edited code appears on the canvas. Anything
// beyond the subset fails the parse loudly; the flow editor then refuses
// instead of corrupting a diagram it does not understand.

import dagre from 'dagre';

export type FlowShape = 'rect' | 'round' | 'diamond';
export type FlowDirection = 'TD' | 'LR';

export interface FlowNode {
  id: string;
  label: string;
  shape: FlowShape;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FlowEdge {
  from: string;
  to: string;
  label: string;
}

export interface FlowGraph {
  direction: FlowDirection;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

/** A node's rendered size (explicit so the canvas and math agree). */
export function nodeSize(label: string, shape: FlowShape): { w: number; h: number } {
  const text = Math.max(96, label.length * 8.5 + 44);
  if (shape === 'diamond') return { w: Math.round(text * 1.35), h: 76 };
  return { w: Math.round(text), h: 46 };
}

/** Thrown for diagrams outside the subset; the editor refuses, never mangles. */
export class FlowParseError extends Error {}

const NODE_TOKEN = /^([A-Za-z0-9_]+)\s*(?:\[([^\]]*)\]|\(([^)]*)\)|\{([^}]*)\})?$/;
const HEADER = /^(?:flowchart|graph)\s+(TD|TB|LR|RL|BT)\s*$/;
const POSITION = /^%%\s*composer:\s*([A-Za-z0-9_]+)\s+(-?\d+),(-?\d+)\s*$/;
/** The labeled (`-- text -->`) and bare (`-->`) edge operators. */
const EDGE_OPERATOR = /--\s*([^>\n]*?)\s*-->|-->/g;

export function parseFlow(code: string): FlowGraph {
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  const positions: Record<string, { x: number; y: number }> = {};
  let direction: FlowDirection = 'TD';
  let sawHeader = false;

  const upsert = (id: string, label?: string, shape?: FlowShape): FlowNode => {
    const existing = nodes.get(id);
    if (existing !== undefined) {
      if (shape !== undefined && existing.shape !== shape) existing.shape = shape;
      if (label !== undefined && label.trim() !== '') existing.label = label;
      return existing;
    }
    const node: FlowNode = {
      id,
      label: label?.trim() !== '' && label !== undefined ? label : id,
      shape: shape ?? 'rect',
      x: 0,
      y: 0,
      ...nodeSize(label ?? '', shape ?? 'rect'),
    };
    // Size depends on the final label; recompute after defaulting.
    Object.assign(node, nodeSize(node.label, node.shape));
    nodes.set(id, node);
    return node;
  };

  const lines = code.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const position = POSITION.exec(trimmed);
    if (position) {
      positions[position[1]!] = { x: Number(position[2]), y: Number(position[3]) };
      continue;
    }
    if (trimmed.startsWith('%%')) continue; // Other comments pass through ignored.
    if (!sawHeader) {
      const header = HEADER.exec(trimmed);
      if (!header) {
        throw new FlowParseError(
          `expected a 'flowchart TD' header, got '${trimmed.slice(0, 40)}'`,
        );
      }
      direction = header[1] === 'LR' ? 'LR' : 'TD';
      sawHeader = true;
      continue;
    }

    // Walk the statement: node token, (operator, node token)*.
    const segments: string[] = [];
    const operators: Array<{ label: string }> = [];
    let cursor = 0;
    EDGE_OPERATOR.lastIndex = 0;
    for (let match = EDGE_OPERATOR.exec(trimmed); match !== null; match = EDGE_OPERATOR.exec(trimmed)) {
      segments.push(trimmed.slice(cursor, match.index));
      operators.push({ label: (match[1] ?? '').trim() });
      cursor = match.index + match[0].length;
    }
    segments.push(trimmed.slice(cursor));
    if (operators.some((operator) => operator.label.includes('-->'))) {
      throw new FlowParseError(`edge label may not contain '-->'`);
    }

    const statement = segments.map((segment, index) => {
      const tokenLine = segment.trim();
      // The `-->|label|` form rides the following node token.
      const piped = /^\|([^|]*)\|\s*(.*)$/.exec(tokenLine);
      if (piped !== null) {
        if (index === 0) {
          throw new FlowParseError(`unsupported diagram syntax: '${trimmed.slice(0, 60)}'`);
        }
        operators[index - 1]!.label = piped[1]!.trim();
        return NODE_TOKEN.exec(piped[2]!);
      }
      return NODE_TOKEN.exec(tokenLine);
    });
    if (statement.some((token) => token === null)) {
      throw new FlowParseError(`unsupported diagram syntax: '${trimmed.slice(0, 60)}'`);
    }
    statement.forEach((token, index) => {
      const shape = token![2] !== undefined ? 'rect' : token![3] !== undefined ? 'round' : token![4] !== undefined ? 'diamond' : undefined;
      upsert(token![1]!, token![2] ?? token![3] ?? token![4], shape as FlowShape | undefined);
      if (index > 0) {
        const previous = statement[index - 1]![1]!;
        edges.push({ from: previous, to: token![1]!, label: operators[index - 1]!.label });
      }
    });
  }

  if (!sawHeader) {
    // An empty (or whitespace) fence starts an empty graph.
    if (nodes.size === 0 && Object.keys(positions).length === 0 && edges.length === 0) {
      return { direction: 'TD', nodes: [], edges: [] };
    }
    throw new FlowParseError('missing a flowchart header');
  }

  applyPositions(nodes, edges, positions, direction);
  return { direction, nodes: [...nodes.values()], edges };
}

/** Dagre fills in positions for nodes the file does not pin down. */
function applyPositions(
  nodes: Map<string, FlowNode>,
  edges: FlowEdge[],
  positions: Record<string, { x: number; y: number }>,
  direction: FlowDirection,
): void {
  const missing = [...nodes.values()].filter((node) => positions[node.id] === undefined);
  if (missing.length > 0) {
    const graph = new dagre.graphlib.Graph();
    graph.setGraph({ rankdir: direction === 'LR' ? 'LR' : 'TB', nodesep: 60, ranksep: 70, marginx: 24, marginy: 24 });
    graph.setDefaultEdgeLabel(() => ({}));
    for (const node of nodes.values()) graph.setNode(node.id, node);
    for (const edge of edges) {
      if (nodes.has(edge.from) && nodes.has(edge.to)) graph.setEdge(edge.from, edge.to);
    }
    dagre.layout(graph);
    for (const node of missing) {
      const laid = graph.node(node.id) as { x: number; y: number } | undefined;
      if (laid !== undefined) positions[node.id] = { x: Math.round(laid.x - node.w / 2), y: Math.round(laid.y - node.h / 2) };
      else positions[node.id] = { x: 40, y: 40 + Object.keys(positions).length * 90 };
    }
  }
  for (const node of nodes.values()) {
    const position = positions[node.id];
    if (position !== undefined) {
      node.x = position.x;
      node.y = position.y;
    }
  }
}

/** Serializes the graph: header, position comments, edge statements. */
export function serializeFlow(graph: FlowGraph): string {
  const lines: string[] = [`flowchart ${graph.direction}`];
  const token = (node: FlowNode, bare: boolean): string => {
    if (bare) return node.id;
    const label = sanitizeLabel(node.label) || node.id;
    switch (node.shape) {
      case 'round':
        return `${node.id}(${label})`;
      case 'diamond':
        return `${node.id}{${label}}`;
      default:
        return `${node.id}[${label}]`;
    }
  };
  for (const node of graph.nodes) {
    lines.push(`%% composer: ${node.id} ${Math.round(node.x)},${Math.round(node.y)}`);
  }
  const declared = new Set<string>();
  for (const edge of graph.edges) {
    const from = graph.nodes.find((node) => node.id === edge.from);
    const to = graph.nodes.find((node) => node.id === edge.to);
    if (from === undefined || to === undefined) continue;
    const parts = [
      declared.has(from.id) ? from.id : token(from, false),
      edge.label.trim() !== '' ? `-- ${sanitizeLabel(edge.label)} -->` : '-->',
      declared.has(to.id) ? to.id : token(to, false),
    ];
    declared.add(from.id);
    declared.add(to.id);
    lines.push(parts.join(' '));
  }
  for (const node of graph.nodes) {
    if (!declared.has(node.id)) lines.push(token(node, false));
  }
  return `${lines.join('\n')}\n`;
}

/** Labels are single-line and cannot carry the edge operator. */
function sanitizeLabel(label: string): string {
  return label.replace(/\s+/g, ' ').replace(/^[->\s]+|[->\s]+$/g, '').replace(/-{2,}/g, '-').trim();
}

/** The next free single-letter id (A, B, … Z, A1, B1, …). */
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

/** The first ```mermaid fence of a document (the flow editor edits one). */
const FENCE = /```mermaid[ \t]*\r?\n([\s\S]*?)```/;

/** The fence's code, or null when the document has no mermaid block. */
export function extractMermaidFence(doc: string): string | null {
  const match = FENCE.exec(doc);
  return match === null ? null : match[1]!;
}

/** Replaces the first fence's code; the rest of the document is untouched. */
export function replaceMermaidFence(doc: string, code: string): string {
  const match = FENCE.exec(doc);
  if (match === null) return doc;
  const body = code.endsWith('\n') ? code : `${code}\n`;
  return `${doc.slice(0, match.index)}\`\`\`mermaid\n${body}\`\`\`${doc.slice(match.index + match[0].length)}`;
}

/** Appends a starter fence for documents that have none yet. */
export function appendMermaidFence(doc: string): string {
  const starter = '```mermaid\nflowchart TD\n```\n';
  return doc === '' || doc.endsWith('\n') ? doc + starter : `${doc}\n${starter}`;
}

/** A straight edge clipped at the two nodes' borders. */
export function edgeGeometry(
  from: FlowNode,
  to: FlowNode,
): { x1: number; y1: number; x2: number; y2: number } {
  const fromCenter = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const toCenter = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  const start = clipToRect(fromCenter, toCenter, from);
  const end = clipToRect(toCenter, fromCenter, to);
  return { x1: start.x, y1: start.y, x2: end.x, y2: end.y };
}

/** Where the center-to-center line leaves one rect. */
function clipToRect(
  center: { x: number; y: number },
  towards: { x: number; y: number },
  node: FlowNode,
): { x: number; y: number } {
  const dx = towards.x - center.x;
  const dy = towards.y - center.y;
  if (dx === 0 && dy === 0) return { x: center.x, y: center.y };
  const half = { w: node.w / 2, h: node.h / 2 };
  const scaleX = dx !== 0 ? half.w / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const scaleY = dy !== 0 ? half.h / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const scale = Math.min(scaleX, scaleY);
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}
