/** A timestamp the client actually set (v1's DEFAULT_TIMESTAMP sentinel → absent here). */
export function isSet(timestamp: string): boolean {
  return timestamp !== '' && Date.parse(timestamp) > 0;
}
