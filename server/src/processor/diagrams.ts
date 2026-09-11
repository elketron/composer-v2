// The diagram domain's commands (Phase 11): the canvas's database-backed
// saves. A blank id allocates the next `DG-N`; a known id upserts. Content
// rides the command and the event — no file is involved. A save that
// changes nothing is a no-op (no revision), matching the pipeline rule. A
// content save that omits the viewport keeps the current one (the
// viewport-only save patches it without touching content).

import { nowIso } from '../wire/envelope.js';
import type { CommandOutcome } from '../wire/commands.js';
import type { Diagram as DiagramJson, DiagramViewport } from '../wire/models.js';
import {
  Diagram,
  isValidViewport,
  normalizeDiagram,
  sameDiagram,
  sameViewport,
} from '../domain/diagram.js';
import { command, allocateId, ok, rejected, toRejection, type CommandMap } from './helpers.js';
import type { Processor } from './index.js';

/** Saves a diagram: validates the content, allocates/upserts the id. */
export async function saveDiagram(
  p: Processor,
  scope: string | undefined,
  diagram: DiagramJson,
): Promise<CommandOutcome> {
  if (scope === undefined || !p.bus.state.projects.has(scope)) {
    return rejected('unknownProject', `Unknown project ${scope ?? ''}`);
  }
  let content;
  try {
    content = normalizeDiagram(diagram);
  } catch (error) {
    return toRejection(error);
  }
  const id =
    diagram.id.trim() !== '' ? diagram.id.trim() : allocateId(p.diagramsOf(scope).keys(), 'DG');
  const current = p.diagramsOf(scope).get(id);
  const candidate: DiagramJson = {
    id,
    projectId: scope,
    name: content.name,
    nodes: content.nodes,
    edges: content.edges,
    groups: content.groups,
    // The canvas sends the viewport only through the viewport-only save
    // (a debounced pan/zoom) — a content save preserves what is stored.
    viewport: diagram.viewport ?? current?.viewport ?? null,
    updatedAt: nowIso(),
  };
  if (current !== undefined && sameDiagram(current, candidate)) {
    return { ok: true, diagramId: id };
  }
  await p.bus.publish(scope, 'diagramSaved', { diagram: candidate });
  return { ok: true, diagramId: id };
}

/** Deletes a diagram; unknown ids reject, matching the pipeline rule. */
export async function deleteDiagram(
  p: Processor,
  scope: string | undefined,
  diagramId: string,
): Promise<CommandOutcome> {
  if (scope === undefined || !p.diagramsOf(scope).has(diagramId)) {
    return rejected('unknownDiagram', `Unknown diagram ${diagramId}`);
  }
  await p.bus.publish(scope, 'diagramDeleted', { diagramId });
  return ok();
}

/**
 * The viewport-only save (pan/zoom): patches the stored viewport in place
 * without touching content, so a pan never collides with a content save.
 * A save that changes nothing is a no-op — panning bursts collapse.
 */
export async function updateDiagramViewport(
  p: Processor,
  scope: string | undefined,
  diagramId: string,
  viewport: DiagramViewport,
): Promise<CommandOutcome> {
  const current = scope === undefined ? undefined : p.diagramsOf(scope).get(diagramId);
  if (current === undefined) {
    return rejected('unknownDiagram', `Unknown diagram ${diagramId}`);
  }
  if (!isValidViewport(viewport)) {
    return rejected('invalidCommand', 'Viewport needs finite coordinates and a positive scale');
  }
  if (sameViewport(current.viewport, viewport)) {
    return { ok: true, diagramId };
  }
  await p.bus.publish(scope!, 'diagramViewportChanged', { diagramId, viewport });
  return { ok: true, diagramId };
}

export const diagramCommands: CommandMap = [
  command('requestDiagramSave', (p, scope, cmd) => saveDiagram(p, scope, cmd.diagram)),
  command('requestDiagramDelete', (p, scope, cmd) => deleteDiagram(p, scope, cmd.diagramId)),
  command('requestDiagramViewport', (p, scope, cmd) =>
    updateDiagramViewport(p, scope, cmd.diagramId, cmd.viewport),
  ),
];