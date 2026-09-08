import type { ToolResult } from './types.js';

export function scoped(scope: string[], projectId: string): ToolResult | null {
  if (!scope.includes(projectId)) {
    return { ok: false, error: `project ${projectId} is not in this thread's scope` };
  }
  return null;
}

export function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`the ${key} argument is required`);
  }
  return value;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
