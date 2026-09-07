// Theme tokens — canonical source is docs/frontend/design.md §1.
// Mirrored as CSS custom properties in styles.scss.

export const tokens = {
  bg: '#0e0e0f',
  panel: '#111112',
  border: '#1a1a1c',
  borderStrong: '#222224',
  text: '#c2c0b6',
  textDim: '#8a8880',
  // WCAG AA on bg/panel (≥4.5:1); keep in sync with --text-faint.
  textFaint: '#827f7b',
  accent: '#4e46a0',
  accentSoft: '#8a82cc',
  ok: '#4CAF82',
  warn: '#d4a843',
  err: '#e05a5a',
  run: '#7ab4e8',
  /** Active-view highlight fill in the left rail. */
  railActiveFill: '#1e1c30',
} as const;

export type Token = keyof typeof tokens;

/** Per-type card accents (design.md §3.2). */
export const cardTypeAccents = {
  coding: tokens.accent,
  design: tokens.warn,
  docs: tokens.ok,
} as const;
