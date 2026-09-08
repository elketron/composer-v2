// The HTTP surface (v1 architecture.md): one generic write endpoint, one
// event stream, and health. Domain rejections are NOT transport errors:
// `200 { ok: false, rejectionCode, rejectionMessage }`; 400 is reserved
// for malformed requests.
//
// The routes live in per-resource modules, each owning the reads it
// serves; this file composes them (and the permissive CORS the desktop
// connects through, including cross-origin when the server runs in WSL
// and the desktop on Windows).

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Bus } from '../bus.js';
import type { Processor } from '../processor/index.js';
import type { EventStore } from '../store/index.js';
import type { KnowledgeStore } from '../knowledge.js';
import { registerActionRoute } from './action.js';
import { registerDashboardRoutes } from './dashboard.js';
import { registerDocsRoutes } from './docs.js';
import { type HttpDeps } from './deps.js';
import { registerEventsRoute } from './events.js';
import { registerHealth } from './health.js';
import { registerKnowledgeRoutes } from './knowledge.js';
import { registerMcpRoutes } from './mcp.js';
import { registerSettingsRoutes } from './settings.js';
import { registerWorkflowRoutes } from './workflows.js';

export function router(
  bus: Bus,
  processor: Processor,
  store?: EventStore,
  knowledge?: KnowledgeStore,
): Hono {
  const app = new Hono();
  app.use('*', cors());

  const deps: HttpDeps = { bus, processor, store, knowledge };
  registerHealth(app);
  registerDashboardRoutes(app, deps);
  registerDocsRoutes(app, deps);
  registerWorkflowRoutes(app, deps);
  registerKnowledgeRoutes(app, deps);
  registerSettingsRoutes(app, deps);
  registerActionRoute(app, deps);
  registerEventsRoute(app, deps);
  registerMcpRoutes(app, deps);

  return app;
}
