// The diagram domain (Phase 11): the canvas's database-backed saves. The
// save allocates ids, normalizes legacy payloads into the explicit V1
// schema (node types, edge ids, groups, viewport), upserts, and refuses
// invalid content; deletion drops the diagram; the viewport-only save
// patches pan/zoom in place; the snapshot replays the saved diagrams into
// an equal fold (the diagrams are database truth, so a reconnect
// reconciles).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Bus } from '../src/bus.js';
import { Processor } from '../src/processor/index.js';
import { apply, newState } from '../src/fold/index.js';
import { snapshotEvents } from '../src/snapshot.js';
import type { Diagram, DiagramViewport } from '../src/wire/models.js';

let dir: string;
let store: InstanceType<typeof import('../src/store/index.js').EventStore>;
let bus: Bus;
let processor: Processor;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'composer-diagram-'));
  const { EventStore } = await import('../src/store/index.js');
  store = new EventStore();
  await store.connect(dir);
  bus = new Bus(store);
  processor = new Processor(bus);
  await processor.execute(undefined, { type: 'requestProjectCreate', name: 'alpha' });
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

function blankDiagram(id: string, name: string): Diagram {
  return {
    id,
    projectId: 'P-1',
    name,
    nodes: [{ id: 'A', label: 'start', x: 40, y: 80, w: 120, h: 46 }],
    edges: [],
    groups: [],
    updatedAt: '',
  };
}

describe('diagram commands', () => {
  it('saves a diagram, allocating a DG id for a fresh draft', async () => {
    const outcome = await processor.execute('P-1', {
      type: 'requestDiagramSave',
      diagram: blankDiagram('', 'Request flow'),
    });

    expect(outcome).toEqual({ ok: true, diagramId: 'DG-1' });
    const saved = bus.state.byProject.get('P-1')?.diagrams.get('DG-1');
    expect(saved?.name).toBe('Request flow');
    expect(saved?.nodes[0]?.id).toBe('A');
    expect(saved?.nodes[0]?.type).toBe('note');
    expect(saved?.groups).toEqual([]);
    expect(saved?.viewport).toBeNull();
  });

  it('normalizes a legacy payload into the explicit V1 schema', async () => {
    await processor.execute('P-1', {
      type: 'requestDiagramSave',
      diagram: {
        id: '',
        projectId: 'P-1',
        name: 'Legacy',
        nodes: [
          { id: 'A', label: 'start', x: 0, y: 0, w: 96, h: 46 },
          { id: 'B', label: 'end', x: 200, y: 0, w: 96, h: 46 },
        ],
        edges: [{ from: 'A', to: 'B', label: 'then' }],
        updatedAt: '',
      } as unknown as Diagram,
    });

    const saved = bus.state.byProject.get('P-1')?.diagrams.get('DG-1');
    expect(saved?.nodes.map((node) => node.type)).toEqual(['note', 'note']);
    expect(saved?.edges[0]?.id).toBe('e-A-B');
    expect(saved?.edges[0]?.label).toBe('then');
    expect(saved?.groups).toEqual([]);
  });

  it('rejects invalid content (blank name, dangling edges, unknown type)', async () => {
    const blank = await processor.execute('P-1', {
      type: 'requestDiagramSave',
      diagram: blankDiagram('', '   '),
    });
    expect(blank.ok).toBe(false);

    const dangling = await processor.execute('P-1', {
      type: 'requestDiagramSave',
      diagram: {
        id: '',
        projectId: 'P-1',
        name: 'Dangling',
        nodes: [{ id: 'A', label: 'x', x: 0, y: 0, w: 96, h: 46 }],
        edges: [{ from: 'A', to: 'B' }],
        groups: [],
        updatedAt: '',
      } as unknown as Diagram,
    });
    expect(dangling.ok).toBe(false);

    const badType = await processor.execute('P-1', {
      type: 'requestDiagramSave',
      diagram: {
        id: '',
        projectId: 'P-1',
        name: 'Types',
        nodes: [{ id: 'A', type: 'wizard', label: 'x', x: 0, y: 0, w: 96, h: 46 }],
        edges: [],
        groups: [],
        updatedAt: '',
      } as unknown as Diagram,
    });
    expect(badType.ok).toBe(false);
  });

  it('rejects a node pointing at an unknown group, saves a valid one', async () => {
    const dangling = await processor.execute('P-1', {
      type: 'requestDiagramSave',
      diagram: {
        id: '',
        projectId: 'P-1',
        name: 'Groups',
        nodes: [{ id: 'A', label: 'x', groupId: 'G1', x: 0, y: 0, w: 96, h: 46 }],
        edges: [],
        groups: [],
        updatedAt: '',
      } as unknown as Diagram,
    });
    expect(dangling.ok).toBe(false);

    const valid = await processor.execute('P-1', {
      type: 'requestDiagramSave',
      diagram: {
        id: '',
        projectId: 'P-1',
        name: 'Groups',
        nodes: [{ id: 'A', type: 'screen', label: 'home', groupId: 'G1', x: 0, y: 0, w: 96, h: 46 }],
        edges: [],
        groups: [{ id: 'G1', label: 'Onboarding', x: 0, y: 0, w: 300, h: 200 }],
        updatedAt: '',
      },
    });
    expect(valid.ok).toBe(true);
    const saved = bus.state.byProject.get('P-1')?.diagrams.get('DG-1');
    expect(saved?.groups[0]?.label).toBe('Onboarding');
    expect(saved?.nodes[0]?.groupId).toBe('G1');
  });

  it('a no-op save does not re-emit, a changed save upserts in place', async () => {
    await processor.execute('P-1', {
      type: 'requestDiagramSave',
      diagram: blankDiagram('', 'Request flow'),
    });

    let emitted = 0;
    bus.subscribe(() => (emitted += 1));
    await processor.execute('P-1', {
      type: 'requestDiagramSave',
      diagram: blankDiagram('DG-1', 'Request flow'),
    });
    expect(emitted).toBe(0);

    await processor.execute('P-1', {
      type: 'requestDiagramSave',
      diagram: blankDiagram('DG-1', 'Renamed'),
    });
    expect(bus.state.byProject.get('P-1')?.diagrams.get('DG-1')?.name).toBe('Renamed');
    expect(bus.state.byProject.get('P-1')?.diagrams.size).toBe(1);
  });

  it('a content save preserves the stored viewport, a changed one rides along', async () => {
    await processor.execute('P-1', {
      type: 'requestDiagramSave',
      diagram: blankDiagram('', 'Request flow'),
    });
    await processor.execute('P-1', {
      type: 'requestDiagramViewport',
      diagramId: 'DG-1',
      viewport: { x: -120, y: 40, scale: 1.5 },
    });

    await processor.execute('P-1', {
      type: 'requestDiagramSave',
      diagram: blankDiagram('DG-1', 'Renamed'),
    });
    expect(bus.state.byProject.get('P-1')?.diagrams.get('DG-1')?.viewport).toEqual({
      x: -120,
      y: 40,
      scale: 1.5,
    });
  });

  it('the viewport-only save patches pan/zoom without touching content', async () => {
    await processor.execute('P-1', {
      type: 'requestDiagramSave',
      diagram: blankDiagram('', 'Request flow'),
    });

    const viewport = { x: -300, y: 220, scale: 0.5 };
    const moved = await processor.execute('P-1', {
      type: 'requestDiagramViewport',
      diagramId: 'DG-1',
      viewport,
    });
    expect(moved.ok).toBe(true);

    let emitted = 0;
    bus.subscribe(() => (emitted += 1));
    const same = await processor.execute('P-1', {
      type: 'requestDiagramViewport',
      diagramId: 'DG-1',
      viewport,
    });
    expect(same.ok).toBe(true);
    expect(emitted).toBe(0);

    const unknown = await processor.execute('P-1', {
      type: 'requestDiagramViewport',
      diagramId: 'DG-99',
      viewport: { x: 0, y: 0, scale: 1 },
    });
    expect(unknown.ok).toBe(false);

    const invalid = await processor.execute('P-1', {
      type: 'requestDiagramViewport',
      diagramId: 'DG-1',
      viewport: { x: 0, y: 0, scale: 0 },
    });
    expect(invalid.ok).toBe(false);

    const saved = bus.state.byProject.get('P-1')?.diagrams.get('DG-1');
    expect(saved?.viewport).toEqual({ x: -300, y: 220, scale: 0.5 });
    expect(saved?.nodes[0]?.x).toBe(40);
  });

  it('deletes a diagram and rejects an unknown id', async () => {
    await processor.execute('P-1', {
      type: 'requestDiagramSave',
      diagram: blankDiagram('', 'Request flow'),
    });

    const unknown = await processor.execute('P-1', {
      type: 'requestDiagramDelete',
      diagramId: 'DG-99',
    });
    expect(unknown.ok).toBe(false);

    const removed = await processor.execute('P-1', {
      type: 'requestDiagramDelete',
      diagramId: 'DG-1',
    });
    expect(removed.ok).toBe(true);
    expect(bus.state.byProject.get('P-1')?.diagrams.size).toBe(0);
  });

  it('the snapshot replays saved diagrams (and viewport) into an equal fold', async () => {
    await processor.execute('P-1', {
      type: 'requestDiagramSave',
      diagram: blankDiagram('', 'Request flow'),
    });
    await processor.execute('P-1', {
      type: 'requestDiagramViewport',
      diagramId: 'DG-1',
      viewport: { x: 10, y: -20, scale: 1.25 } satisfies DiagramViewport,
    });

    const replayed = newState();
    for (const frame of snapshotEvents(bus.state, 'P-1')) {
      apply(replayed, {
        id: frame.id,
        projectId: frame.projectId,
        occurredAt: frame.occurredAt,
        name: frame.eventType,
        body: frame.body,
      });
    }

    const saved = replayed.byProject.get('P-1')?.diagrams.get('DG-1');
    expect(saved?.name).toBe('Request flow');
    expect(saved?.viewport).toEqual({ x: 10, y: -20, scale: 1.25 });
    expect(saved?.nodes[0]?.type).toBe('note');
  });
});