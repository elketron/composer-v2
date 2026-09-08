// The MCP tools' validated routes (D8, S34, Phase 6): composition only. The
// planner's command route, the assistant's read/write routes, and the
// workers' recording/retrieval route each live in their own registrar
// (mcp/*.ts); this file composes them onto the one router. None of these are
// a second generic action surface — each is whitelisted to its agent's
// tools.

import type { Hono } from 'hono';
import type { HttpDeps } from './deps.js';
import { registerAssistantMcpRoutes } from './mcp/assistant.js';
import { registerPlannerMcpRoutes } from './mcp/planner.js';
import { registerWorkerMcpRoutes } from './mcp/worker.js';

export function registerMcpRoutes(app: Hono, deps: HttpDeps): void {
  registerPlannerMcpRoutes(app, deps);
  registerAssistantMcpRoutes(app, deps);
  registerWorkerMcpRoutes(app, deps);
}