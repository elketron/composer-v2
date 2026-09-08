import type { Command } from '../wire/commands.js';
import { readString } from '../wire/read.js';

export interface ActionContext {
  body: Record<string, unknown>;
  scopeProjectId?: string;
  str(key: string): string | undefined;
  bool(key: string): boolean | undefined;
}

export type ActionParser = (context: ActionContext) => Command | null;
export type ActionRegistry = Record<string, ActionParser>;

export function actionContext(
  body: Record<string, unknown>,
  scopeProjectId?: string,
): ActionContext {
  return {
    body,
    scopeProjectId,
    str: (key) => readString(body, key),
    bool: (key) => typeof body[key] === 'boolean' ? body[key] : undefined,
  };
}
