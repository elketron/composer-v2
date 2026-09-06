import { marked } from 'marked';

/**
 * Safe markdown for user-visible agent output (the S11 rule, shared):
 * raw HTML is escaped first (tags display literally, nothing executes),
 * then Angular's default innerHTML sanitization guards the generated
 * markup (e.g. javascript: hrefs) — no sanitizer bypass.
 */
export function renderMarkdown(text: string): string {
  if (!text) return '';
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return marked.parse(escaped, { async: false });
}
