/** The coercion helpers the wire-parsing models share (FNT-012). */

/** True for a non-null object (arrays included — narrow further at call sites). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The value's string entries; non-strings and empty strings drop. */
export function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item !== '')
    : [];
}

/** One chat message's role: anything but the agent's is the user's. */
export function normalizeMessageRole(role: 'user' | 'agent' | string): 'user' | 'agent' {
  return role.toLowerCase() === 'agent' ? 'agent' : 'user';
}

/** The timestamp as ISO (a missing one is now). */
export function toIso(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString();
  return value ?? new Date().toISOString();
}
