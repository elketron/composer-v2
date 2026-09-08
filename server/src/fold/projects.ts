// The project domain's fold steps: creation, directory linkage, archive,
// and restore (the active tab is UI state — projectActivated folds to
// nothing).

import { Project } from '../domain/project.js';
import { projectStateOf, readBody, type FoldHandler } from './state.js';
import type { EventBodyMap } from '../wire/events.js';

export const projectHandlers: Record<string, FoldHandler> = {
  projectCreated: (state, envelope) => {
    const body = readBody(envelope, 'projectCreated');
    state.projects.set(body.project.id, Project.fromWire(body.project));
    projectStateOf(state, body.project.id);
  },
  projectDirectoryChanged: (state, envelope) => {
    const body = readBody(envelope, 'projectDirectoryChanged');
    const project = state.projects.get(body.projectId);
    if (project) state.projects.set(body.projectId, project.with({ directory: body.directory }));
  },
  // Active tab is UI state; the event exists for other subscribers.
  projectActivated: () => undefined,
  projectArchived: (state, envelope) => {
    const body = readBody(envelope, 'projectArchived');
    const project = state.projects.get(body.projectId);
    if (project) state.projects.set(body.projectId, project.with({ archivedAt: body.archivedAt }));
  },
  projectRestored: (state, envelope) => {
    const body = readBody(envelope, 'projectRestored');
    const project = state.projects.get(body.projectId);
    if (project) state.projects.set(body.projectId, project.with({ archivedAt: undefined }));
  },
};
