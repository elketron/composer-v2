import {
  FlowParseError,
  edgeGeometry,
  extractMermaidFence,
  appendMermaidFence,
  nextNodeId,
  nodeSize,
  parseFlow,
  replaceMermaidFence,
  serializeFlow,
} from './flow-graph';

describe('flow-graph', () => {
  it('parses shapes, chains, and labels', () => {
    const graph = parseFlow(
      [
        'flowchart TD',
        'A[Draft] --> B{Review} -- ok --> C(Merge)',
        'A -- fix --> A',
      ].join('\n'),
    );
    expect(graph.direction).toBe('TD');
    expect(graph.nodes.map((node) => `${node.id}:${node.label}:${node.shape}`)).toEqual([
      'A:Draft:rect',
      'B:Review:diamond',
      'C:Merge:round',
    ]);
    expect(graph.edges).toEqual([
      { from: 'A', to: 'B', label: '' },
      { from: 'B', to: 'C', label: 'ok' },
      { from: 'A', to: 'A', label: 'fix' },
    ]);
  });

  it('parses the pipe label form and graph headers', () => {
    const graph = parseFlow('graph LR\nA -->|yes| B');
    expect(graph.direction).toBe('LR');
    expect(graph.edges).toEqual([{ from: 'A', to: 'B', label: 'yes' }]);
  });

  it('positions round-trip through composer comments', () => {
    const first = parseFlow('flowchart TD\nA[Start] --> B[End]');
    first.nodes[0]!.x = 220;
    first.nodes[0]!.y = 140;
    const code = serializeFlow(first);
    expect(code).toContain('%% composer: A 220,140');

    const second = parseFlow(code);
    expect(second.nodes[0]).toMatchObject({ id: 'A', x: 220, y: 140, label: 'Start' });
    // The other node was laid out by dagre and serialized back with a pin.
    expect(second.nodes[1]!.x).not.toBe(0);
  });

  it('serialize-then-parse preserves the whole graph', () => {
    const source = parseFlow(
      'flowchart TD\nA[Start] --> B{Gate}\nB -- approved --> C[Ship]\nB -- rejected --> A',
    );
    const roundTripped = parseFlow(serializeFlow(source));
    expect(roundTripped.direction).toBe(source.direction);
    expect(roundTripped.nodes.map((node) => `${node.id}:${node.label}:${node.shape}`)).toEqual(
      source.nodes.map((node) => `${node.id}:${node.label}:${node.shape}`),
    );
    expect(roundTripped.edges).toEqual(source.edges);
  });

  it('an empty fence parses as an empty graph', () => {
    expect(parseFlow('')).toEqual({ direction: 'TD', nodes: [], edges: [] });
    expect(parseFlow('   \n\n')).toEqual({ direction: 'TD', nodes: [], edges: [] });
  });

  it('refuses what the subset does not cover', () => {
    expect(() => parseFlow('flowchart TD\nA -.-> B')).toThrow(FlowParseError);
    expect(() => parseFlow('flowchart TD\nsubgraph X\nA\nend')).toThrow(FlowParseError);
    expect(() => parseFlow('A --> B')).toThrow(FlowParseError); // missing header
    expect(() => parseFlow('flowchart TD\nA -->|nope| |double| B')).toThrow(FlowParseError);
  });

  it('ids and geometry helpers behave', () => {
    expect(nextNodeId([])).toBe('A');
    expect(nextNodeId(['A', 'B', 'D'])).toBe('C');
    expect(nextNodeId(['A', 'B', 'C'])).toBe('D');
    expect(nodeSize('a longer label', 'diamond').w).toBeGreaterThan(nodeSize('a', 'rect').w);

    const a = { id: 'A', label: 'A', shape: 'rect' as const, x: 0, y: 0, ...nodeSize('A', 'rect') };
    const b = { id: 'B', label: 'B', shape: 'rect' as const, x: 300, y: 0, ...nodeSize('B', 'rect') };
    const wire = edgeGeometry(a, b);
    expect(wire.x1).toBeCloseTo(a.w); // Leaves A's right border.
    expect(wire.x2).toBeCloseTo(300); // Enters B's left border.
    expect(wire.y1).toBeCloseTo(a.h / 2);
  });

  it('fence helpers splice only the mermaid block', () => {
    const doc = '# Title\n\n```mermaid\nflowchart TD\nA --> B\n```\n\nTail text.\n';
    expect(extractMermaidFence(doc)).toBe('flowchart TD\nA --> B\n');
    const replaced = replaceMermaidFence(doc, 'flowchart LR\nC --> D');
    expect(replaced).toContain('flowchart LR\nC --> D\n');
    expect(replaced).toContain('# Title');
    expect(replaced).toContain('Tail text.');
    expect(replaced).not.toContain('A --> B');

    const appended = appendMermaidFence('# Only text\n');
    expect(extractMermaidFence(appended)).toContain('flowchart TD');
  });
});
