import { TestBed } from '@angular/core/testing';

import { FakeEventsClient, provideFakeEventsClient } from '../core/events/events-client.fake';
import { ShellService } from '../shell/shell.service';
import { Diagram } from '../core/models/diagram.models';
import { DiagramService } from './diagram.service';
import type { DiagramJson } from '../core/events/wire';

describe('DiagramService', () => {
  let events: FakeEventsClient;
  let counter = 0;

  const create = (): DiagramService => TestBed.inject(DiagramService);

  beforeEach(async () => {
    events = new FakeEventsClient();
    await TestBed.configureTestingModule({
      providers: [provideFakeEventsClient(events)],
    }).compileComponents();
  });

  const activate = (projectId: string): void => {
    events.emit({
      id: `tab-${projectId}`,
      projectId,
      occurredAt: '',
      projectCreated: { project: { id: projectId, name: projectId, createdAt: '' } },
    });
    TestBed.inject(ShellService).activateTab(projectId);
  };

  const diagram = (id: string, name = 'Request flow'): Diagram =>
    new Diagram({
      id,
      name,
      nodes: [
        {
          id: 'A',
          type: 'screen',
          label: 'start',
          description: 'the entry point',
          groupId: null,
          x: 0,
          y: 0,
          w: 96,
          h: 46,
        },
      ],
      edges: [{ id: 'e-A-B', from: 'A', to: 'B', label: 'then' }],
      groups: [{ id: 'G-1', label: 'Onboarding', x: 0, y: 0, w: 300, h: 200 }],
      viewport: null,
    });

  const saved = (json: DiagramJson): void =>
    events.emit({
      id: `diagram-${events.published.length + counter++}`,
      projectId: 'P-1',
      occurredAt: '',
      diagramSaved: { diagram: json },
    });

  it('folds saved and deleted diagrams per project', () => {
    const service = create();
    activate('P-1');
    expect(service.diagrams()).toEqual([]);

    saved({
      id: 'DG-1',
      projectId: 'P-1',
      name: 'Request flow',
      nodes: [],
      edges: [],
      groups: [],
      updatedAt: '',
    });
    expect(service.diagrams().map((entry) => entry.id)).toEqual(['DG-1']);

    events.emit({ id: 'diagram-2', projectId: 'P-1', occurredAt: '', diagramDeleted: { diagramId: 'DG-1' } });
    expect(service.diagrams()).toEqual([]);
  });

  it('migrates a legacy payload: nodes read as note, edge ids fill in', () => {
    const service = create();
    activate('P-1');

    saved({
      id: 'DG-1',
      projectId: 'P-1',
      name: 'Legacy',
      nodes: [{ id: 'A', label: 'old', x: 1, y: 2, w: 96, h: 46 }],
      edges: [{ from: 'A', to: 'B', label: 'goes' }],
      updatedAt: '',
    } as unknown as DiagramJson);

    const folded = service.diagrams()[0];
    expect(folded?.nodes[0]?.type).toBe('note');
    expect(folded?.nodes[0]?.description).toBe('');
    expect(folded?.nodes[0]?.groupId).toBeNull();
    expect(folded?.edges[0]?.id).toBe('e-A-B');
    expect(folded?.edges[0]?.label).toBe('goes');
    expect(folded?.groups).toEqual([]);
  });

  it('upserts a re-saved diagram without duplicating', () => {
    const service = create();
    activate('P-1');

    saved({ id: 'DG-1', projectId: 'P-1', name: 'One', nodes: [], edges: [], groups: [], updatedAt: '' });
    saved({ id: 'DG-1', projectId: 'P-1', name: 'Renamed', nodes: [], edges: [], groups: [], updatedAt: '' });

    expect(service.diagrams().map((entry) => entry.name)).toEqual(['Renamed']);
  });

  it('a viewport echo patches pan/zoom without touching content', () => {
    const service = create();
    activate('P-1');

    saved({ id: 'DG-1', projectId: 'P-1', name: 'One', nodes: [], edges: [], groups: [], updatedAt: '' });
    events.emit({
      id: 'vp-1',
      projectId: 'P-1',
      occurredAt: '',
      diagramViewportChanged: { diagramId: 'DG-1', viewport: { x: 5, y: -5, scale: 2 } },
    });

    const folded = service.diagrams()[0];
    expect(folded?.viewport).toEqual({ x: 5, y: -5, scale: 2 });
    expect(folded?.name).toBe('One');
  });

  it('save publishes the diagram over the events transport', async () => {
    const service = create();
    activate('P-1');

    const result = await service.save('P-1', diagram('', 'Request flow'));

    expect(result.ok).toBe(true);
    expect(events.lastCommand('requestDiagramSave')?.projectId).toBe('P-1');
  });

  it('saveViewport publishes the viewport-only command', async () => {
    const service = create();
    activate('P-1');

    const ok = await service.saveViewport('P-1', 'DG-1', { x: -12, y: 30, scale: 1.4 });

    expect(ok).toBe(true);
    const command = events.lastCommand('requestDiagramViewport');
    expect(command?.requestDiagramViewport?.diagramId).toBe('DG-1');
    expect(command?.requestDiagramViewport?.viewport).toEqual({ x: -12, y: 30, scale: 1.4 });
  });

  it('remove publishes a delete and surfaces a server rejection', async () => {
    const service = create();
    activate('P-1');

    const ok = await service.remove('P-1', 'DG-1');
    expect(ok).toBe(true);
    expect(events.lastCommand('requestDiagramDelete')?.requestDiagramDelete?.diagramId).toBe('DG-1');

    events.respondWith({ ok: false, rejectionMessage: 'the server refused the request' });
    expect(await service.remove('P-1', 'DG-9')).toBe(false);
    expect(service.rejection()).toBe('the server refused the request');
  });
});
