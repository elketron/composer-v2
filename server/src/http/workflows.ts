// The workflow reads (S34): straight reads over the project's recorded
// procedures — the files are the truth, the log carries metadata only. The
// project-directory guard is the shared helper (project-dir.ts).
import type { Hono } from 'hono';
import type { HttpDeps } from './deps.js';
import { listWorkflows, readWorkflow, searchWorkflows } from '../workflows.js';
import { resolveProjectDirectory } from './project-dir.js';

export function registerWorkflowRoutes(app: Hono, deps: HttpDeps): void {
  const { bus } = deps;

  app.get('/projects/:projectId/workflows', (context) => {
    const resolved = resolveProjectDirectory(bus, context.req.param('projectId'));
    if ('directory' in resolved) {
      return context.json({ workflows: listWorkflows(resolved.directory) });
    }
    return context.json(resolved.body, resolved.status);
  });

  app.get('/projects/:projectId/workflows/content', (context) => {
    const path = context.req.query('path') ?? '';
    const resolved = resolveProjectDirectory(bus, context.req.param('projectId'));
    if ('directory' in resolved) {
      const result = readWorkflow(resolved.directory, path);
      if (!result.ok) {
        return context.json({ error: result.error });
      }
      return context.json({ workflow: { ...result.value.info, content: result.value.content } });
    }
    return context.json(resolved.body, resolved.status);
  });

  app.get('/projects/:projectId/workflows/search', (context) => {
    const query = context.req.query('q') ?? '';
    const resolved = resolveProjectDirectory(bus, context.req.param('projectId'));
    if ('directory' in resolved) {
      return context.json({
        results: searchWorkflows(resolved.directory, query).map((result) => ({
          ...result.info,
          snippet: result.snippet,
          score: result.score,
        })),
      });
    }
    return context.json(resolved.body, resolved.status);
  });
}