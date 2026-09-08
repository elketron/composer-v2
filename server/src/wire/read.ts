// Lenient JSON field readers — the parse side of the wire (defaults where
// absent, wrong-typed values fall back). The domain objects' `fromAction`
// parses and the action envelope's translation both read raw client JSON
// through these.

export function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

export function readObject(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

export function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

/** The record the raw JSON meant (an empty record when it isn't an object). */
export function asRecord(json: unknown): Record<string, unknown> {
  return typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
}
