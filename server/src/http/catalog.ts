// The executor catalogs route: the read-only predefined agents and runtime
// steps the pipeline editor offers. No project scope — the catalogs are
// server-wide.

import type { Hono } from 'hono';
import { PIPELINE_AGENTS, PIPELINE_CATEGORIES, RUNTIME_STEPS } from '../agents/catalog.js';

export function registerCatalogRoutes(app: Hono): void {
  app.get('/catalog', (context) =>
    context.json({ agents: PIPELINE_AGENTS, runtimeSteps: RUNTIME_STEPS, categories: PIPELINE_CATEGORIES }),
  );
}