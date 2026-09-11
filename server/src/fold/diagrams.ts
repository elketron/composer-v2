// The diagram domain's fold steps (Phase 11): saved diagrams upsert by id,
// deletions drop the key, and viewport saves patch the pan/zoom in place.
// The content rides the saved event, so the fold holds the current
// definition and the snapshot replays it.

import { Diagram } from '../domain/diagram.js';
import { projectStateOf, readBody, type FoldHandler } from './state.js';

export const diagramHandlers: Record<string, FoldHandler> = {
  diagramSaved: (state, envelope, projectId) => {
    const body = readBody(envelope, 'diagramSaved');
    const project = projectStateOf(state, projectId);
    project.diagrams.set(body.diagram.id, Diagram.fromWire(body.diagram));
  },
  diagramDeleted: (state, envelope, projectId) => {
    const body = readBody(envelope, 'diagramDeleted');
    const project = projectStateOf(state, projectId);
    project.diagrams.delete(body.diagramId);
  },
  diagramViewportChanged: (state, envelope, projectId) => {
    const body = readBody(envelope, 'diagramViewportChanged');
    const project = projectStateOf(state, projectId);
    const diagram = project.diagrams.get(body.diagramId);
    if (diagram === undefined) return;
    project.diagrams.set(body.diagramId, diagram.withViewport(body.viewport));
  },
};