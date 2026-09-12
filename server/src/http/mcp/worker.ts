// The workers' composer-tool route (S34): the recording tools land on the
// validated processor (the session binding rides the command); the
// retrieval tools read the project's workflow files. Every call re-validates
// the project and session — the client carries no authority.

import type { Hono } from 'hono';
import type { HttpDeps } from '../deps.js';
import { executeWorkerTool, WORKER_MCP_TOOLS } from '../../agents/worker/index.js';

export function registerWorkerMcpRoutes(app: Hono, deps: HttpDeps): void {
  app.post('/mcp/worker', async (context) => {
    const body = await context.req
      .json<{ projectId?: unknown; sessionId?: unknown; tool?: unknown; args?: unknown }>()
      .catch(() => undefined);
    const projectId = typeof body?.projectId === 'string' ? body.projectId : '';
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
    const tool = typeof body?.tool === 'string' ? body.tool : '';
    const args =
      typeof body?.args === 'object' && body?.args !== null ? (body!.args as Record<string, unknown>) : {};
    if (projectId === '' || sessionId === '' || !WORKER_MCP_TOOLS.has(tool)) {
      return context.json({ error: 'malformed worker call', detail: 'unknown worker tool' }, 400);
    }
    const result = await executeWorkerTool(deps, projectId, sessionId, tool, args);
    return context.json(result);
  });
}