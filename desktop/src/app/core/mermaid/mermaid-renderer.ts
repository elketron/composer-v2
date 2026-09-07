import { Injectable, InjectionToken, inject } from '@angular/core';

/**
 * One mermaid diagram → its SVG markup (Phase 9 S28). The renderer is an
 * injectable boundary: the real one lazy-imports mermaid (kept out of the
 * initial bundle) and the directive injects it; specs substitute a fake —
 * jsdom has no SVG measurement, so real rendering is a browser concern.
 * Implementations throw on invalid diagrams; callers show the error.
 */
export interface MermaidRenderer {
  render(code: string): Promise<string>;
}

export const MERMAID_RENDERER = new InjectionToken<MermaidRenderer>('composer.mermaid.renderer', {
  providedIn: 'root',
  factory: () => inject(LazyMermaidRenderer),
});

let renderSequence = 0;

/** The production renderer: mermaid, strict and dark, loaded on demand. */
@Injectable({ providedIn: 'root' })
export class LazyMermaidRenderer implements MermaidRenderer {
  private initialized: Promise<typeof import('mermaid').default> | null = null;

  async render(code: string): Promise<string> {
    const mermaid = await this.mermaid();
    const id = `composer-mermaid-${++renderSequence}`;
    const { svg } = await mermaid.render(id, code);
    return svg;
  }

  /**
   * One-time initialize: no auto-render pass of its own (the directive
   * drives), strict security (diagram text is sanitized, click handlers
   * off), dark theme for the app's palette.
   */
  private mermaid() {
    this.initialized ??= import('mermaid').then((module) => {
      const mermaid = module.default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'dark',
        fontFamily: 'inherit',
      });
      return mermaid;
    });
    return this.initialized;
  }
}
