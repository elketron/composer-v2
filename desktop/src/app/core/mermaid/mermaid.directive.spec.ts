import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { renderMarkdown } from '../markdown';
import { MERMAID_RENDERER, MermaidRenderer } from './mermaid-renderer';
import { MermaidDirective } from './mermaid.directive';

/** Fake renderers the specs inject: one succeeds, one always rejects. */
class FakeRenderer implements MermaidRenderer {
  readonly calls: string[] = [];
  constructor(private readonly svg: string) {}
  render(code: string): Promise<string> {
    this.calls.push(code);
    return Promise.resolve(this.svg.replace('%CODE%', code.trim()));
  }
}

class FailingRenderer implements MermaidRenderer {
  render(): Promise<string> {
    return Promise.reject(new Error('syntax error in graph'));
  }
}

@Component({
  template:
    '<div class="pane" [innerHTML]="html()" [appMermaid]="html()"></div>',
  imports: [MermaidDirective],
})
class HostComponent {
  readonly html = signal('');
}

describe('MermaidDirective', () => {
  function make(renderer: MermaidRenderer): ComponentFixture<HostComponent> {
    TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [{ provide: MERMAID_RENDERER, useValue: renderer }],
    });
    return TestBed.createComponent(HostComponent);
  }

  async function settled(fixture: ComponentFixture<HostComponent>): Promise<void> {
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('replaces a mermaid fence with the rendered svg', async () => {
    const renderer = new FakeRenderer('<svg data-fake="%CODE%"></svg>');
    const fixture = make(renderer);
    fixture.componentInstance.html.set(
      renderMarkdown('intro\n\n```mermaid\ngraph TD; A-->B;\n```\n\noutro'),
    );
    await settled(fixture);

    const pane = (fixture.nativeElement as HTMLElement).querySelector('.pane')!;
    expect(pane.querySelector('svg[data-fake="graph TD; A-->B;"]')).toBeTruthy();
    expect(pane.querySelector('code.language-mermaid')).toBeNull();
    expect(pane.textContent).toContain('intro');
    expect(pane.textContent).toContain('outro');
    expect(renderer.calls).toEqual(['graph TD; A-->B;']);
  });

  it('leaves ordinary code blocks alone', async () => {
    const renderer = new FakeRenderer('<svg></svg>');
    const fixture = make(renderer);
    fixture.componentInstance.html.set(renderMarkdown('```ts\nconst a = 1;\n```'));
    await settled(fixture);

    const pane = (fixture.nativeElement as HTMLElement).querySelector('.pane')!;
    expect(pane.querySelector('code.language-ts')).toBeTruthy();
    expect(pane.querySelector('.mermaid-block')).toBeNull();
    expect(renderer.calls).toEqual([]);
  });

  it('a broken diagram becomes a visible error that keeps the source', async () => {
    const fixture = make(new FailingRenderer());
    fixture.componentInstance.html.set(
      renderMarkdown('```mermaid\ngraph TD; A-->\n```'),
    );
    await settled(fixture);

    const failure = (fixture.nativeElement as HTMLElement).querySelector('.mermaid-error')!;
    expect(failure.querySelector('span')?.textContent).toContain('syntax error in graph');
    expect(failure.querySelector('pre')?.textContent).toContain('graph TD; A-->');
  });

  it('a stale render discards itself when the content changed meanwhile', async () => {
    const resolvers: Array<(svg: string) => void> = [];
    const deferred: MermaidRenderer = {
      render: () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    };
    const fixture = make(deferred);
    fixture.componentInstance.html.set(renderMarkdown('```mermaid\nfirst\n```'));
    await settled(fixture);
    expect((fixture.nativeElement as HTMLElement).querySelector('.mermaid-pending')).toBeTruthy();

    // New content while the first render is in flight: generation moves on.
    fixture.componentInstance.html.set(renderMarkdown('```mermaid\nsecond\n```'));
    await settled(fixture);

    // The first render lands late — it must not touch the DOM.
    resolvers[0]!('<svg data-first="1"></svg>');
    await settled(fixture);
    expect((fixture.nativeElement as HTMLElement).querySelector('svg[data-first]')).toBeNull();
  });
});
