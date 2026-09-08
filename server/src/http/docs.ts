// The docs reads (Phase 9): content lives in the project's files, so these
// are straight reads over the docs layer — no event log involved.
import type { Hono } from 'hono';
import type { HttpDeps } from './deps.js';
import { listDocs, readDoc } from '../docs/index.js';


export function registerDocsRoutes(app: Hono, deps: HttpDeps): void {
  const { bus } = deps;
  // Docs reads (Phase 9): content lives in the project's files, so these
  // are straight reads over the docs layer — no event log involved.
  app.get('/projects/:projectId/docs', (context) => {
    const projectId = context.req.param('projectId');
    const project = bus.state.projects.get(projectId);
    if (!project) {
      return context.json({ error: `unknown project ${projectId}` }, 404);
    }
    if (project.directory === undefined) {
      return context.json({ error: `project ${projectId} has no directory` });
    }
    const result = listDocs(project.directory);
    if (!result.ok) {
      return context.json({ error: result.error });
    }
    return context.json({ docs: result.value });
  });

  app.get('/projects/:projectId/docs/content', (context) => {
    const projectId = context.req.param('projectId');
    const path = context.req.query('path') ?? '';
    const project = bus.state.projects.get(projectId);
    if (!project) {
      return context.json({ error: `unknown project ${projectId}` }, 404);
    }
    if (project.directory === undefined) {
      return context.json({ error: `project ${projectId} has no directory` });
    }
    const result = readDoc(project.directory, path);
    if (!result.ok) {
      return context.json({ error: result.error });
    }
    return context.json({ doc: { ...result.value.info, content: result.value.content } });
  });
}
