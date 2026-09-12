/**
 * The relative-age ladder (FNT-008): "just now", "5m ago", "1h ago",
 * "3d ago", then the locale date. `AgePipe` and the canvas's diagram
 * stamps share it.
 */
export function ageLabel(at: Date | string | number, now = Date.now()): string {
  const then = at instanceof Date ? at.getTime() : new Date(at).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}
