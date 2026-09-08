// The project-directory route guard (SRV-020): every file-reading route
// resolves the same way — an unknown project is a 404, a linked project
// without a directory is a 400-less "no directory", a linked project yields
// its directory. This helper keeps that policy in one place so the docs and
// workflow routes don't drift.

import type { Bus } from '../bus.js';

export type ProjectDirectory =
  | { directory: string }
  | { body: { error: string }; status: 404 | undefined };

export function resolveProjectDirectory(bus: Bus, projectId: string): ProjectDirectory {
  const project = bus.state.projects.get(projectId);
  if (project === undefined) {
    return { body: { error: `unknown project ${projectId}` }, status: 404 };
  }
  if (project.directory === undefined) {
    return { body: { error: `project ${projectId} has no directory` }, status: undefined };
  }
  return { directory: project.directory };
}