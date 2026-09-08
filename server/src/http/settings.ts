// Global settings (config, not domain history): the desktop's settings view
// reads and writes these; the runner/planner read them per spawn. The models
// route lists the runtime's available models.
import type { Hono } from 'hono';
import type { HttpDeps } from './deps.js';
import type { SettingsPatch } from '../store/settings.js';
import { listOpenCodeModels } from '../models.js';


export function registerSettingsRoutes(app: Hono, deps: HttpDeps): void {
  const { store } = deps;
  // Global settings (config, not domain history): the desktop's settings
  // view reads and writes these; the runner/planner read them per spawn.
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
    const body = (await context.req.json<unknown>().catch(() => undefined)) as Record<
      string,
      unknown
    > | undefined;
    if (typeof body !== 'object' || body === null) {
      return context.json({ error: 'malformed settings' }, 400);
    }
    const patch: SettingsPatch = {};
    if ('model' in body) {
      const model = body['model'];
      if (model !== null && typeof model !== 'string') {
        return context.json({ error: 'malformed settings', detail: 'model must be a string' }, 400);
      }
      // A string sets (trimmed); null or '' clears the override.
      const trimmed = typeof model === 'string' ? model.trim() : '';
      patch.model = trimmed === '' ? null : trimmed;
    }
    if ('models' in body) {
      const raw = body['models'];
      if (raw !== null && typeof raw !== 'object') {
        return context.json({ error: 'malformed settings', detail: 'models must be an object' }, 400);
      }
      if (raw === null) {
        patch.models = {};
      } else {
        const models: Record<string, string | null> = {};
        for (const [kind, value] of Object.entries(raw as Record<string, unknown>)) {
          if (value !== null && typeof value !== 'string') {
            return context.json(
              { error: 'malformed settings', detail: `models.${kind} must be a string` },
              400,
            );
          }
          models[kind] = typeof value === 'string' ? value.trim() : null;
        }
        patch.models = models;
      }
    }
    const saved = await store.putSettings(patch);
    return context.json(saved);
  });
}
