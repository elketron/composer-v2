// Global app settings (config, not domain history — outside the log):
// a global default model and per-agent overrides. The processor-independent
// surface the runner/planner read per spawn and the settings routes write.

/** Global (not per-project) app settings. */
export interface ComposerSettings {
  /** The model every agent loads when no per-agent override exists. */
  model?: string;
  /** Per-agent model overrides, keyed by the bare agent kind (planner, coder, …). */
  models?: Record<string, string>;
}

/** A settings update: a value sets the field, null clears it, absent leaves it.
 * `models` (when present) replaces the whole per-agent map. */
export interface SettingsPatch {
  model?: string | null;
  models?: Record<string, string | null>;
}

/** The model an agent kind loads: its override, else the global default. */
export function resolveModel(settings: ComposerSettings, agentKind: string): string | undefined {
  return settings.models?.[agentKind] ?? settings.model;
}

/**
 * The settings a raw DB row projects to — tolerant: malformed or empty
 * values drop, so a hand-edited or legacy row still reads.
 */
export function normalizeStoredSettings(
  raw: { model?: string | null; models?: Record<string, string> | null } | undefined,
): ComposerSettings {
  const settings: ComposerSettings = {};
  if (typeof raw?.model === 'string' && raw.model !== '') settings.model = raw.model;
  if (raw?.models !== null && typeof raw?.models === 'object') {
    const models: Record<string, string> = {};
    for (const [kind, model] of Object.entries(raw.models)) {
      if (typeof model === 'string' && model !== '') models[kind] = model;
    }
    if (Object.keys(models).length > 0) settings.models = models;
  }
  return settings;
}

/**
 * Applies a validated patch: a `model` of null/'' clears the field, and a
 * `models` patch replaces the whole per-agent map (trimmed; empties drop).
 */
export function applySettingsPatch(current: ComposerSettings, patch: SettingsPatch): ComposerSettings {
  const next: ComposerSettings = {
    ...(current.model !== undefined ? { model: current.model } : {}),
    ...(current.models !== undefined ? { models: { ...current.models } } : {}),
  };
  if (patch.model !== undefined) {
    if (patch.model === null || patch.model === '') delete next.model;
    else next.model = patch.model;
  }
  if (patch.models !== undefined) {
    const models: Record<string, string> = {};
    for (const [kind, model] of Object.entries(patch.models)) {
      const key = kind.trim();
      const value = typeof model === 'string' ? model.trim() : '';
      if (key !== '' && value !== '') models[key] = value;
    }
    if (Object.keys(models).length > 0) next.models = models;
    else delete next.models;
  }
  return next;
}

/** The patch a settings body carries, or its transport rejection (400). */
export type SettingsPatchResult =
  | { ok: true; patch: SettingsPatch }
  | { ok: false; error: string; detail?: string };

/**
 * The transport parser: validates the body's types (rejecting with a 400
 * detail) and trims the values that ride the patch. Everything else is the
 * repository's `applySettingsPatch` concern.
 */
export function parseSettingsPatch(body: unknown): SettingsPatchResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'malformed settings' };
  }
  const record = body as Record<string, unknown>;
  const patch: SettingsPatch = {};
  if ('model' in record) {
    const model = record['model'];
    if (model !== null && typeof model !== 'string') {
      return { ok: false, error: 'malformed settings', detail: 'model must be a string' };
    }
    const trimmed = typeof model === 'string' ? model.trim() : '';
    patch.model = trimmed === '' ? null : trimmed;
  }
  if ('models' in record) {
    const raw = record['models'];
    if (raw !== null && typeof raw !== 'object') {
      return { ok: false, error: 'malformed settings', detail: 'models must be an object' };
    }
    if (raw === null) {
      patch.models = {};
    } else {
      const models: Record<string, string | null> = {};
      for (const [kind, value] of Object.entries(raw as Record<string, unknown>)) {
        if (value !== null && typeof value !== 'string') {
          return { ok: false, error: 'malformed settings', detail: `models.${kind} must be a string` };
        }
        models[kind] = typeof value === 'string' ? value.trim() : null;
      }
      patch.models = models;
    }
  }
  return { ok: true, patch };
}

