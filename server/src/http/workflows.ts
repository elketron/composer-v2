// The workflow reads (S34): straight reads over the project's recorded
// procedures — the files are the truth, the log carries metadata only.
import type { Hono } from 'hono';
import type { HttpDeps } from './deps.js';
import { listWorkflows, readWorkflow, searchWorkflows } from '../workflows.js';


export function registerWorkflowRoutes(app: Hono, deps: HttpDeps): void {
  const { bus } = deps;
  // Workflow reads (S34): straight reads over the project's recorded
  // procedures — the files are the truth, the log carries metadata only.
  app.get('/projects/:projectId/workflows', (context) => {
    const projectId = context.req.param('projectId');
    const project = bus.state.projects.get(projectId);
    if (!project) {
      return context.json({ error: `unknown project ${projectId}` }, 404);
    }
    if (project.directory === undefined) {
      return context.json({ error: `project ${projectId} has no directory` });
    }
    return context.json({ workflows: listWorkflows(project.directory) });
  });

  app.get('/projects/:projectId/workflows/content', (context) => {
    const projectId = context.req.param('projectId');
    const path = context.req.query('path') ?? '';
    const project = bus.state.projects.get(projectId);
    if (!project) {
      return context.json({ error: `unknown project ${projectId}` }, 404);
    }
    if (project.directory === undefined) {
      return context.json({ error: `project ${projectId} has no directory` });
    }
    const result = readWorkflow(project.directory, path);
    if (!result.ok) {
      return context.json({ error: result.error });
    }
    return context.json({ workflow: { ...result.value.info, content: result.value.content } });
  });

  app.get('/projects/:projectId/workflows/search', (context) => {
    const projectId = context.req.param('projectId');
    const project = bus.state.projects.get(projectId);
    if (!project) {
      return context.json({ error: `unknown project ${projectId}` }, 404);
    }
    if (project.directory === undefined) {
      return context.json({ error: `project ${projectId} has no directory` });
    }
    const query = context.req.query('q') ?? '';
    return context.json({
      results: searchWorkflows(project.directory, query).map((result) => ({
        ...result.info,
        snippet: result.snippet,
        score: result.score,
      })),
    });
  });
}
