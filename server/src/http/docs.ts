// The docs reads (Phase 9): content lives in the project's files, so these
// are straight reads over the docs layer — no event log involved. The
// project-directory guard is the shared helper (project-dir.ts).
import type { Hono } from 'hono';
import type { HttpDeps } from './deps.js';
import { listDocs, readDoc } from '../docs/index.js';
import { resolveProjectDirectory } from './project-dir.js';

export function registerDocsRoutes(app: Hono, deps: HttpDeps): void {
  const { bus } = deps;
  app.get('/projects/:projectId/docs', (context) => {
    const resolved = resolveProjectDirectory(bus, context.req.param('projectId'));
    if ('directory' in resolved) {
      const result = listDocs(resolved.directory);
      if (!result.ok) {
        return context.json({ error: result.error });
      }
      return context.json({ docs: result.value });
    }
    return context.json(resolved.body, resolved.status);
  });

  app.get('/projects/:projectId/docs/content', (context) => {
    const path = context.req.query('path') ?? '';
    const resolved = resolveProjectDirectory(bus, context.req.param('projectId'));
    if ('directory' in resolved) {
      const result = readDoc(resolved.directory, path);
      if (!result.ok) {
        return context.json({ error: result.error });
      }
      return context.json({ doc: { ...result.value.info, content: result.value.content } });
    }
    return context.json(resolved.body, resolved.status);
  });
}