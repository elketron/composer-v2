import { asRecord, readNumber } from '../wire/read.js';
import type { Diagram as DiagramJson } from '../wire/models.js';
import type { ActionRegistry } from './types.js';

const nodes = (value: unknown): DiagramJson['nodes'] =>
  Array.isArray(value) ? (value as DiagramJson['nodes']) : [];

const edges = (value: unknown): DiagramJson['edges'] =>
  Array.isArray(value) ? (value as DiagramJson['edges']) : [];

const groups = (value: unknown): DiagramJson['groups'] =>
  Array.isArray(value) ? (value as DiagramJson['groups']) : [];

const viewport = (value: unknown): DiagramJson['viewport'] => {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = asRecord(value);
  if (!Number.isFinite(record['x'] as number) || !Number.isFinite(record['y'] as number)) {
    return undefined;
  }
  return {
    x: record['x'] as number,
    y: record['y'] as number,
    scale: typeof record['scale'] === 'number' && record['scale'] > 0 ? record['scale'] : 1,
  };
};

export const diagramActions: ActionRegistry = {
  'create:diagram': ({ body, str, scopeProjectId }) => ({
    type: 'requestDiagramSave',
    diagram: {
      id: str('id') ?? '',
      projectId: scopeProjectId ?? '',
      name: str('name') ?? '',
      nodes: nodes(body['nodes']),
      edges: edges(body['edges']),
      groups: groups(body['groups']),
      viewport: viewport(body['viewport']),
      updatedAt: '',
    },
  }),
  'delete:diagram': ({ str }) => ({
    type: 'requestDiagramDelete',
    diagramId: str('id') ?? '',
  }),
  // The viewport-only save (update): pan/zoom rides alone so the desktop's
  // debounced panning never collides with a content save.
  'update:diagram': ({ body, str }) => {
    const viewport = asRecord(body['viewport']);
    return {
      type: 'requestDiagramViewport',
      diagramId: str('id') ?? '',
      viewport: {
        x: readNumber(viewport, 'x'),
        y: readNumber(viewport, 'y'),
        scale: readNumber(viewport, 'scale') || 1,
      },
    };
  },
};
