// Global settings (config, not domain history): the desktop's settings view
// reads and writes these; the runner/planner read them per spawn. The models
// route lists the runtime's available models. The write path only parses and
// rejects malformed transport types (`parseSettingsPatch`); normalization
// and persistence live in the settings repository.
import type { Hono } from 'hono';
import type { HttpDeps } from './deps.js';
import { parseSettingsPatch } from '../store/settings.js';
import { listOpenCodeModels } from '../models.js';

export function registerSettingsRoutes(app: Hono, deps: HttpDeps): void {
  const { store } = deps;
  app.get('/settings', async (context) => {
    const settings = store ? await store.getSettings() : {};
    return context.json(settings);
  });
  app.get('/models', async (context) => {
    try {
      return context.json({ models: await listOpenCodeModels() });
    } catch (error) {
      return context.json(
        {
          error: 'models unavailable',
          detail: error instanceof Error ? error.message : String(error),
        },
        503,
      );
    }
  });
  app.put('/settings', async (context) => {
    if (store === undefined) {
      return context.json({ error: 'settings unavailable' }, 503);
    }
    const body = await context.req.json<unknown>().catch(() => undefined);
    const result = parseSettingsPatch(body);
    if (!result.ok) {
      return context.json(
        { error: result.error, ...(result.detail !== undefined ? { detail: result.detail } : {}) },
        400,
      );
    }
    const saved = await store.putSettings(result.patch);
    return context.json(saved);
  });
}