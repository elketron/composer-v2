// The flow-graph layer (Phase 9 S31): a strict mermaid flowchart subset —
// rect `[a]`, rounded `(a)`, and diamond `{a}` nodes chained with `-->`,
// optionally labeled (`-- text -->`, `-->|text|`), plus one level of
// Mermaid subgraphs. Composer metadata comments preserve canvas geometry
// and node annotations while the saved file remains readable Mermaid.

import dagre from "dagre";

export type FlowShape = "rect" | "round" | "diamond";
export type FlowDirection = "TD" | "TB" | "LR" | "RL" | "BT";

export interface FlowNode {
  id: string;
  label: string;
  type: string;
  description: string;
  groupId: string | null;
  shape: FlowShape;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FlowGroup {
  id: string;
  label: string;
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
  groups: FlowGroup[];
}

/** A node's rendered size (explicit so the canvas and math agree). */
export function nodeSize(
  label: string,
  shape: FlowShape,
): { w: number; h: number } {
  const text = Math.max(96, label.length * 8.5 + 44);
  if (shape === "diamond") return { w: Math.round(text * 1.35), h: 76 };
  return { w: Math.round(text), h: 46 };
}

/** Thrown for diagrams outside the subset; the editor refuses, never mangles. */
export class FlowParseError extends Error {}

const HEADER = /^(?:flowchart|graph)\s+(TD|TB|LR|RL|BT)\s*$/;
const POSITION = /^%%\s*composer:\s*([A-Za-z0-9_]+)\s+(-?\d+),(-?\d+)\s*$/;
const NODE_META =
  /^%%\s*composer:\s*node\s+([A-Za-z0-9_]+)\s+(-?\d+),(-?\d+)(?:\s+(\{.*\}))?\s*$/;
const GROUP_META =
  /^%%\s*composer:\s*group\s+([A-Za-z0-9_]+)\s+(-?\d+),(-?\d+),(\d+),(\d+)\s*$/;
const SUBGRAPH =
  /^subgraph\s+([A-Za-z0-9_]+)(?:\s*\[\s*(?:"((?:&quot;|[^"])*)"|([^\[\]]*))\s*\])?\s*$/;
/** The labeled (`-- text -->`) and bare (`-->`) edge operators. */
const EDGE_OPERATOR = /--\s*([^>\n]*?)\s*-->|-->/g;

export function parseFlow(code: string): FlowGraph {
  const nodes = new Map<string, FlowNode>();
  const groups = new Map<string, FlowGroup>();
  const edges: FlowEdge[] = [];
  const positions: Record<string, { x: number; y: number }> = {};
  const annotations: Record<string, { type?: string; description?: string }> =
    {};
  const groupGeometry: Record<
    string,
    { x: number; y: number; w: number; h: number }
  > = {};
  let direction: FlowDirection = "TD";
  let sawHeader = false;
  let currentGroup: string | null = null;

  const upsert = (id: string, label?: string, shape?: FlowShape): FlowNode => {
    const existing = nodes.get(id);
    if (existing !== undefined) {
      if (shape !== undefined && existing.shape !== shape)
        existing.shape = shape;
      if (label !== undefined && label.trim() !== "") existing.label = label;
      if (currentGroup !== null) existing.groupId = currentGroup;
      return existing;
    }
    if (groups.has(id)) {
      throw new FlowParseError(`'${id}' cannot be both a node and a group`);
    }
    const node: FlowNode = {
      id,
      label: label?.trim() !== "" && label !== undefined ? label : id,
      type: annotations[id]?.type ?? "",
      description: annotations[id]?.description ?? "",
      groupId: currentGroup,
      shape: shape ?? "rect",
      x: 0,
      y: 0,
      ...nodeSize(label ?? "", shape ?? "rect"),
    };
    // Size depends on the final label; recompute after defaulting.
    Object.assign(node, nodeSize(node.label, node.shape));
    nodes.set(id, node);
    return node;
  };

  const lines = code.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const nodeMeta = NODE_META.exec(trimmed);
    if (nodeMeta) {
      positions[nodeMeta[1]!] = {
        x: Number(nodeMeta[2]),
        y: Number(nodeMeta[3]),
      };
      if (nodeMeta[4] !== undefined)
        annotations[nodeMeta[1]!] = parseAnnotation(nodeMeta[4]);
      continue;
    }
    const groupMeta = GROUP_META.exec(trimmed);
    if (groupMeta) {
      groupGeometry[groupMeta[1]!] = {
        x: Number(groupMeta[2]),
        y: Number(groupMeta[3]),
        w: Number(groupMeta[4]),
        h: Number(groupMeta[5]),
      };
      continue;
    }
    const position = POSITION.exec(trimmed);
    if (position) {
      positions[position[1]!] = {
        x: Number(position[2]),
        y: Number(position[3]),
      };
      continue;
    }
    if (/^%%\s*composer:/.test(trimmed)) {
      throw new FlowParseError("invalid Composer diagram metadata");
    }
    if (trimmed.startsWith("%%")) continue;
    if (!sawHeader) {
      const header = HEADER.exec(trimmed);
      if (!header) {
        throw new FlowParseError(
          `expected a 'flowchart TD' header, got '${trimmed.slice(0, 40)}'`,
        );
      }
      direction = header[1] as FlowDirection;
      sawHeader = true;
      continue;
    }

    const subgraph = SUBGRAPH.exec(trimmed);
    if (subgraph !== null) {
      if (currentGroup !== null)
        throw new FlowParseError("nested groups are not supported");
      const id = subgraph[1]!;
      if (nodes.has(id))
        throw new FlowParseError(`'${id}' cannot be both a node and a group`);
      if (groups.has(id)) throw new FlowParseError(`duplicate group '${id}'`);
      const label = decodeLabel((subgraph[2] ?? subgraph[3])?.trim() || id)!;
      const geometry = groupGeometry[id] ?? { x: 24, y: 24, w: 360, h: 220 };
      groups.set(id, { id, label, ...geometry });
      currentGroup = id;
      continue;
    }
    if (trimmed === "end") {
      if (currentGroup === null) throw new FlowParseError("unexpected 'end'");
      currentGroup = null;
      continue;
    }

    // Walk the statement: node token, (operator, node token)*.
    const segments: string[] = [];
    const operators: Array<{ label: string }> = [];
    let cursor = 0;
    EDGE_OPERATOR.lastIndex = 0;
    for (
      let match = EDGE_OPERATOR.exec(trimmed);
      match !== null;
      match = EDGE_OPERATOR.exec(trimmed)
    ) {
      segments.push(trimmed.slice(cursor, match.index));
      operators.push({ label: (match[1] ?? "").trim() });
      cursor = match.index + match[0].length;
    }
    segments.push(trimmed.slice(cursor));
    if (operators.some((operator) => operator.label.includes("-->"))) {
      throw new FlowParseError(`edge label may not contain '-->'`);
    }

    const statement = segments.map((segment, index) => {
      const tokenLine = segment.trim();
      // The `-->|label|` form rides the following node token.
      const piped = /^\|([^|]*)\|\s*(.*)$/.exec(tokenLine);
      if (piped !== null) {
        if (index === 0) {
          throw new FlowParseError(
            `unsupported diagram syntax: '${trimmed.slice(0, 60)}'`,
          );
        }
        operators[index - 1]!.label = piped[1]!.trim();
        return parseNodeToken(piped[2]!);
      }
      return parseNodeToken(tokenLine);
    });
    if (statement.some((token) => token === null)) {
      throw new FlowParseError(
        `unsupported diagram syntax: '${trimmed.slice(0, 60)}'`,
      );
    }
    statement.forEach((token, index) => {
      upsert(token!.id, token!.label, token!.shape);
      if (index > 0) {
        const previous = statement[index - 1]!.id;
        edges.push({
          from: previous,
          to: token!.id,
          label: decodeLabel(operators[index - 1]!.label)!,
        });
      }
    });
  }

  if (!sawHeader) {
    // An empty (or whitespace) fence starts an empty graph.
    if (
      nodes.size === 0 &&
      Object.keys(positions).length === 0 &&
      edges.length === 0
    ) {
      return { direction: "TD", nodes: [], edges: [], groups: [] };
    }
    throw new FlowParseError("missing a flowchart header");
  }
  if (currentGroup !== null)
    throw new FlowParseError(`group '${currentGroup}' is missing 'end'`);

  applyPositions(nodes, edges, positions, direction);
  for (const node of nodes.values()) {
    node.type = annotations[node.id]?.type ?? "";
    node.description = annotations[node.id]?.description ?? "";
  }
  fitMissingGroups(groups, nodes, groupGeometry);
  return {
    direction,
    nodes: [...nodes.values()],
    edges,
    groups: [...groups.values()],
  };
}

function parseNodeToken(
  value: string,
): { id: string; label?: string; shape?: FlowShape } | null {
  const match = /^([A-Za-z0-9_]+)\s*(.*)$/.exec(value.trim());
  if (match === null) return null;
  const id = match[1]!;
  const shapeText = match[2]!;
  if (shapeText === "") return { id };

  const shapes: Array<{ open: string; close: string; shape: FlowShape }> = [
    { open: "[", close: "]", shape: "rect" },
    { open: "(", close: ")", shape: "round" },
    { open: "{", close: "}", shape: "diamond" },
  ];
  const matchedShape = shapes.find(
    ({ open, close }) =>
      shapeText.startsWith(open) && shapeText.endsWith(close),
  );
  if (matchedShape === undefined) return null;
  const inner = shapeText.slice(1, -1);
  const quoted = inner.startsWith('"') && inner.endsWith('"');
  if (!quoted && /[\[\]{}()]/.test(inner)) return null;
  if (quoted && inner.slice(1, -1).includes('"')) return null;
  return { id, label: decodeLabel(inner), shape: matchedShape.shape };
}

function parseAnnotation(json: string): {
  type?: string;
  description?: string;
} {
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error("not an object");
    if (
      Object.keys(value).some((key) => key !== "type" && key !== "description")
    )
      throw new Error("unknown field");
    if (value["type"] !== undefined && typeof value["type"] !== "string")
      throw new Error("invalid type");
    if (
      value["description"] !== undefined &&
      typeof value["description"] !== "string"
    )
      throw new Error("invalid description");
    return {
      type: typeof value["type"] === "string" ? value["type"] : undefined,
      description:
        typeof value["description"] === "string"
          ? value["description"]
          : undefined,
    };
  } catch {
    throw new FlowParseError("invalid Composer node metadata");
  }
}

function decodeLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const unquoted =
    value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  return unquoted
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function fitMissingGroups(
  groups: Map<string, FlowGroup>,
  nodes: Map<string, FlowNode>,
  geometry: Record<string, { x: number; y: number; w: number; h: number }>,
): void {
  for (const group of groups.values()) {
    if (geometry[group.id] !== undefined) continue;
    const children = [...nodes.values()].filter(
      (node) => node.groupId === group.id,
    );
    if (children.length === 0) continue;
    const left = Math.min(...children.map((node) => node.x));
    const top = Math.min(...children.map((node) => node.y));
    const right = Math.max(...children.map((node) => node.x + node.w));
    const bottom = Math.max(...children.map((node) => node.y + node.h));
    Object.assign(group, {
      x: left - 32,
      y: top - 52,
      w: right - left + 64,
      h: bottom - top + 84,
    });
  }
}

/** Dagre fills in positions for nodes the file does not pin down. */
function applyPositions(
  nodes: Map<string, FlowNode>,
  edges: FlowEdge[],
  positions: Record<string, { x: number; y: number }>,
  direction: FlowDirection,
): void {
  const missing = [...nodes.values()].filter(
    (node) => positions[node.id] === undefined,
  );
  if (missing.length > 0) {
    const graph = new dagre.graphlib.Graph();
    graph.setGraph({
      rankdir: direction === "TD" ? "TB" : direction,
      nodesep: 60,
      ranksep: 70,
      marginx: 24,
      marginy: 24,
    });
    graph.setDefaultEdgeLabel(() => ({}));
    for (const node of nodes.values()) graph.setNode(node.id, node);
    for (const edge of edges) {
      if (nodes.has(edge.from) && nodes.has(edge.to))
        graph.setEdge(edge.from, edge.to);
    }
    dagre.layout(graph);
    for (const node of missing) {
      const laid = graph.node(node.id) as { x: number; y: number } | undefined;
      if (laid !== undefined)
        positions[node.id] = {
          x: Math.round(laid.x - node.w / 2),
          y: Math.round(laid.y - node.h / 2),
        };
      else
        positions[node.id] = {
          x: 40,
          y: 40 + Object.keys(positions).length * 90,
        };
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
    const label = serializeNodeLabel(node.label) || node.id;
    switch (node.shape) {
      case "round":
        return `${node.id}(${label})`;
      case "diamond":
        return `${node.id}{${label}}`;
      default:
        return `${node.id}[${label}]`;
    }
  };
  for (const group of graph.groups) {
    lines.push(
      `%% composer: group ${group.id} ${Math.round(group.x)},${Math.round(group.y)},${Math.round(group.w)},${Math.round(group.h)}`,
    );
  }
  for (const node of graph.nodes) {
    const annotation =
      node.type !== "" || node.description !== ""
        ? ` ${JSON.stringify({ type: node.type, description: node.description })}`
        : "";
    lines.push(
      `%% composer: node ${node.id} ${Math.round(node.x)},${Math.round(node.y)}${annotation}`,
    );
  }
  const declared = new Set<string>();
  for (const group of graph.groups) {
    lines.push(
      `subgraph ${group.id}["${escapeLabel(group.label) || group.id}"]`,
    );
    for (const node of graph.nodes.filter(
      (candidate) => candidate.groupId === group.id,
    )) {
      lines.push(`  ${token(node, false)}`);
      declared.add(node.id);
    }
    lines.push("end");
  }
  for (const node of graph.nodes) {
    if (
      node.groupId === null ||
      !graph.groups.some((group) => group.id === node.groupId)
    ) {
      lines.push(token(node, false));
      declared.add(node.id);
    }
  }
  for (const edge of graph.edges) {
    const from = graph.nodes.find((node) => node.id === edge.from);
    const to = graph.nodes.find((node) => node.id === edge.to);
    if (from === undefined || to === undefined) continue;
    const parts = [
      declared.has(from.id) ? from.id : token(from, false),
      edge.label.trim() !== ""
        ? `-- ${sanitizeEdgeLabel(edge.label)} -->`
        : "-->",
      declared.has(to.id) ? to.id : token(to, false),
    ];
    lines.push(parts.join(" "));
  }
  return `${lines.join("\n")}\n`;
}

function serializeNodeLabel(label: string): string {
  const singleLine = label
    .replace(/[\n\r]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /[\[\]{}()"]/.test(singleLine)
    ? `"${escapeLabel(singleLine)}"`
    : singleLine;
}

function escapeLabel(label: string): string {
  return label
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/>/g, "&gt;")
    .replace(/</g, "&lt;")
    .replace(/[\n\r]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeEdgeLabel(label: string): string {
  return escapeLabel(label);
}

/** The next free single-letter id (A, B, … Z, A1, B1, …). */
export function nextNodeId(existing: readonly string[]): string {
  const taken = new Set(existing);
  for (let round = 0; round < 100; round += 1) {
    const suffix = round === 0 ? "" : String(round);
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
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
  const body = code.endsWith("\n") ? code : `${code}\n`;
  return `${doc.slice(0, match.index)}\`\`\`mermaid\n${body}\`\`\`${doc.slice(match.index + match[0].length)}`;
}

/** Appends a starter fence for documents that have none yet. */
export function appendMermaidFence(doc: string): string {
  const starter = "```mermaid\nflowchart TD\n```\n";
  return doc === "" || doc.endsWith("\n")
    ? doc + starter
    : `${doc}\n${starter}`;
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
