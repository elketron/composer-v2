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

