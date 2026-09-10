// The justfile route: one project's justfile recipes (the editor's
// presets). Project-scoped with the `projectId` query — the recipes are
// the project directory's own.

import type { Hono } from 'hono';
import { justfileRecipes } from '../filesystem/justfile.js';
import type { HttpDeps } from './deps.js';

export function registerJustfileRoutes(app: Hono, deps: HttpDeps): void {
  const { bus } = deps;

  app.get('/justfile', async (context) => {
    const projectId = context.req.query('projectId') ?? '';
    const project = bus.state.byProject.get(projectId);
    if (project === undefined) {
      return context.json({ error: `unknown project ${projectId}` }, 404);
    }
    const recipes = await justfileRecipes(bus.state.projects.get(projectId)?.directory);
    return context.json({ recipes });
  });
}
