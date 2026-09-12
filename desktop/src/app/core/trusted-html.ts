import type { DomSanitizer, SafeHtml } from '@angular/platform-browser';

import { renderMarkdown } from './markdown';

/**
 * The one sanitizer bypass for rendered markup (FNT-009): markdown
 * (`renderMarkdown`) and diff2html output are the only HTML the app
 * trusts, and only through here — views never call
 * `bypassSecurityTrustHtml` themselves.
 */

/** Marks already-rendered HTML as safe. */
export function trustHtml(sanitizer: DomSanitizer, html: string): SafeHtml {
  return sanitizer.bypassSecurityTrustHtml(html);
}

/** Renders markdown to trusted HTML in one step. */
export function renderTrustedMarkdown(sanitizer: DomSanitizer, text: string): SafeHtml {
  return trustHtml(sanitizer, renderMarkdown(text));
}
