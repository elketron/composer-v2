import { describe, expect, it } from 'vitest';

import { Diagram } from './diagram.models';
import { DiagramDraft } from './diagram-draft';

function saved(): Diagram {
  return Diagram.fromWire({
    id: 'D-1',
    name: 'Checkout flow',
    nodes: [
      { id: 'A', type: 'screen', label: 'Cart', description: '', groupId: null, x: 0, y: 0, w: 160, h: 46 },
      { id: 'B', type: 'process', label: 'Charge', description: '', groupId: null, x: 300, y: 0, w: 160, h: 46 },
    ],
    edges: [{ id: 'e-A-B', from: 'A', to: 'B', label: 'pay' }],
    groups: [],
    viewport: { x: 10, y: 20, scale: 1 },
    updatedAt: '',
  });
}

describe('DiagramDraft', () => {
  it('opens a saved diagram clean and round-trips it (the load normalization never reads as an edit)', () => {
    const diagram = saved();
    const draft = DiagramDraft.open(diagram);
    expect(draft.dirtyAgainst(diagram)).toBe(false);
    // The projection rebuilds an equal diagram (content-wise).
    const projection = draft.toDiagram(diagram.id, diagram.viewport!, diagram.name);
    expect(projection.name).toBe('Checkout flow');
    expect(projection.nodes).toEqual(diagram.nodes);
    expect(projection.edges).toEqual(diagram.edges);
    expect(projection.groups).toEqual(diagram.groups);
    // …and the projection is itself clean against the saved one.
    expect(DiagramDraft.open(projection).dirtyAgainst(projection)).toBe(false);
  });

  it('detects edits of every kind and reads reverts as clean', () => {
    const diagram = saved();
    const base = DiagramDraft.open(diagram);

    expect(base.rename('Checkout flow v2').dirtyAgainst(diagram)).toBe(true);

    const relabeled = base.setNodeLabel('A', 'Basket');
    expect(relabeled.dirtyAgainst(diagram)).toBe(true);

    const moved = base.moveNodes(new Map([['A', { x: 30, y: 5 }]]), new Set());
    expect(moved.dirtyAgainst(diagram)).toBe(true);
    // Positions are exact data — a revert reads clean again.
    expect(moved.moveNodes(new Map([['A', { x: 0, y: 0 }]]), new Set()).dirtyAgainst(diagram)).toBe(false);

    const retyped = base.setNodeType('A', 'decision');
    expect(retyped.dirtyAgainst(diagram)).toBe(true);
    // (A label/type revert keeps the grown frame — grow-only, like the
    // load; the user just saves. No shrink-reshuffle of layouts.)

    expect(base.setNodeDescription('A', 'the items').dirtyAgainst(diagram)).toBe(true);
    expect(base.setEdgeLabel('e-A-B', 'pay now').dirtyAgainst(diagram)).toBe(true);
  });

  it('creation rules: ids allocate past taken ones and a node over a group joins it', () => {
    const draft = DiagramDraft.open(saved());

    const added = draft.addNode('note', { x: 300, y: 0 });
    expect(added.nodeId).toBe('C');
    expect(added.draft.node('C')?.type).toBe('note');

    const grouping = draft.groupSelection(['A', 'B']);
    const withGroup = grouping.draft;
    expect(grouping.groupId).toBe('G1');
    // A node created inside the group's frame joins it.
    const inside = withGroup.addNode('note', { x: 20, y: 10 });
    expect(inside.draft.node(inside.nodeId)?.groupId).toBe('G1');

    // Group bounds wrap the selection (pad 24 all around).
    const group = withGroup.group('G1')!;
    expect(group.x).toBe(-24);
    expect(group.y).toBe(-24);
    expect(group.w).toBe(460 + 48);
    expect(group.h).toBe(46 + 48);
  });

  it('the connection guard: refused when self, dangling, or duplicate', () => {
    const draft = DiagramDraft.open(saved());

    expect(draft.connect('A', 'B').edgeId).toBeNull(); // duplicate of e-A-B
    expect(draft.connect('A', 'A').edgeId).toBeNull(); // self
    expect(draft.connect('A', 'Z').edgeId).toBeNull(); // dangling

    const created = draft.connect('B', 'A');
    expect(created.edgeId).toBe('e-B-A');
    expect(created.draft.dirtyAgainst(saved())).toBe(true);
  });

  it('moves: moved groups drag their children; drag-out leaves the group; drops re-join', () => {
    const grouping = DiagramDraft.open(saved()).groupSelection(['A']);
    const draft = grouping.draft;
    const groupId = grouping.groupId!;
    const member = draft.node('A')!;
    const group = draft.group(groupId)!;
    expect(member.groupId).toBe(groupId);

    // Dragging the group (foblex reports absolute positions): the group
    // lands at (group.x + 10, group.y + 10), the member follows by the
    // same delta.
    const moved = draft.moveNodes(
      new Map([[groupId, { x: group.x + 10, y: group.y + 10 }]]),
      new Set([groupId]),
    );
    const dragged = moved.node('A')!;
    expect(dragged.x).toBe(member.x + 10);
    expect(dragged.y).toBe(member.y + 10);

    // A node dragged far out of the group's frame leaves it.
    const out = moved.moveNodes(new Map([[member.id, { x: 900, y: 900 }]]), new Set());
    expect(out.node(member.id)?.groupId).toBeNull();

    // A drop back onto the group re-joins it.
    const rejoined = out.dropToGroup([member.id], groupId);
    expect(rejoined.node(member.id)?.groupId).toBe(groupId);
  });

  it('deletes: nodes take their edges, group deletes keep the nodes, selection deletes all three kinds', () => {
    const draft = DiagramDraft.open(saved());

    const noB = draft.deleteNodes(['B']);
    expect(noB.nodes.map((node) => node.id)).toEqual(['A']);
    expect(noB.edges).toEqual([]); // e-A-B died with B

    const grouping = draft.groupSelection(['A']);
    const grouped = grouping.draft;
    const groupId = grouping.groupId!;
    expect(grouped.node('A')?.groupId).toBe(groupId);

    const ungrouped = grouped.deleteGroups([groupId]);
    expect(ungrouped.node('A')?.groupId).toBeNull();
    expect(ungrouped.groups).toEqual([]);

    const keyboard = draft.deleteSelection({
      nodeIds: [],
      groupIds: [groupId],
      edgeIds: ['e-A-B'],
    });
    void keyboard;
  });

  it('the keyboard delete clears membership, then the edge, in one event', () => {
    const grouping = DiagramDraft.open(saved()).groupSelection(['A']);
    const draft = grouping.draft;
    const groupId = grouping.groupId!;

    const keyboard = draft.deleteSelection({
      nodeIds: [],
      groupIds: [groupId],
      edgeIds: ['e-A-B'],
    });
    expect(keyboard.groups).toEqual([]);
    expect(keyboard.nodes.every((node) => node.groupId === null)).toBe(true);

    const everything = keyboard.deleteSelection({
      nodeIds: ['A', 'B'],
      groupIds: [],
      edgeIds: [],
    });
    expect(everything.nodes).toEqual([]);
    expect(everything.edges).toEqual([]);
  });

  it('an empty name saves as the fallback name (the UNTITLED rule lives in the projection)', () => {
    const draft = DiagramDraft.blank('');
    const projection = draft.toDiagram('D-2', { x: 0, y: 0, scale: 1 }, 'Untitled');
    expect(projection.name).toBe('Untitled');
  });
});
