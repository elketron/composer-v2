import { DestroyRef, Directive, ElementRef, effect, inject, input } from '@angular/core';

import { MERMAID_RENDERER } from './mermaid-renderer';

/**
 * Enhances rendered markdown (Phase 9 S28): scans the element's HTML for
 * ```mermaid fences — which `renderMarkdown` leaves as plain
 * `language-mermaid` code blocks, because diagrams render asynchronously —
 * and replaces each with the diagram's SVG. A diagram that fails to parse
 * becomes a visible error panel that keeps the source visible; nothing
 * throws into the host view.
 *
 * The host keeps its own `[innerHTML]` binding; the directive re-scans on
 * every input change (re-binding resets the DOM, so the scan always sees
 * fresh code blocks). SVG lands via DOM APIs — no sanitizer bypass beyond
 * what the host already applies, and mermaid's strict mode sanitizes the
 * diagram text itself.
 */
@Directive({
  selector: '[appMermaid]',
})
export class MermaidDirective {
  /** The markdown-derived HTML the host rendered (change trigger). */
  readonly appMermaid = input.required<string>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly renderer = inject(MERMAID_RENDERER);
  private readonly destroyRef = inject(DestroyRef);
  /** Incremented on every input change; stale renders discard themselves. */
  private generation = 0;

  constructor() {
    effect(() => {
      const html = this.appMermaid();
      const generation = ++this.generation;
      void this.enhance(generation);
    });
    this.destroyRef.onDestroy(() => {
      this.generation = -1;
    });
  }

  private async enhance(generation: number): Promise<void> {
    const blocks = this.host.nativeElement.querySelectorAll('pre > code.language-mermaid');
    for (const block of blocks) {
      const pre = block.parentElement;
      if (pre === null) continue;
      const code = decodeEntities(block.textContent ?? '').trim();
      const placeholder = document.createElement('div');
      placeholder.className = 'mermaid-block mermaid-pending';
      placeholder.textContent = 'rendering diagram…';
      pre.replaceWith(placeholder);
      try {
        const svg = await this.renderer.render(code);
        if (generation !== this.generation) return; // Content changed meanwhile.
        const diagram = document.createElement('div');
        diagram.className = 'mermaid-block';
        diagram.innerHTML = svg;
        placeholder.replaceWith(diagram);
      } catch (error) {
        if (generation !== this.generation) return;
        const message = error instanceof Error ? error.message : String(error);
        const failure = document.createElement('div');
        failure.className = 'mermaid-error';
        const note = document.createElement('span');
        note.textContent = `diagram error: ${message}`;
        const source = document.createElement('pre');
        source.textContent = code;
        failure.append(note, source);
        placeholder.replaceWith(failure);
      }
    }
  }
}

/**
 * The escape-first markdown pipeline (S11) leaves code content escaped —
 * and marked escapes the escapes — so the DOM text of a fence holds the
 * author's `-->` as `--&gt;`. One decode pass recovers the authored text
 * (a literal `&gt;` in the source survives as `&gt;`, which mermaid then
 * sees exactly as written).
 */
function decodeEntities(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}
