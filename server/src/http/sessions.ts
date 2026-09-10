// The agent sessions' read route: one session's working-tree diffs (the
// run view's file rows fetch on demand). Reads are project-scoped with the
// `projectId` query (the fold is per project); the patches compute from
// git against the project directory at request time.

import type { Hono } from 'hono';
import { sessionFilePatches } from '../filesystem/git-changes.js';
import type { HttpDeps } from './deps.js';

export function registerSessionRoutes(app: Hono, deps: HttpDeps): void {
  const { bus } = deps;

  app.get('/sessions/:sessionId/diff', async (context) => {
    const sessionId = context.req.param('sessionId');
    const projectId = context.req.query('projectId') ?? '';
    const project = bus.state.byProject.get(projectId);
    const session = project?.agentSessions.get(sessionId);
    if (project === undefined || session === undefined) {
      return context.json({ error: `unknown session ${sessionId}` }, 404);
    }
    const directory = bus.state.projects.get(projectId)?.directory;
    const paths = (session.files ?? []).map((file) => file.path);
    const files = await sessionFilePatches(directory, paths);
    return context.json({ files });
  });
}
