import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { FlowEditorComponent } from './flow-editor.component';
import { parseFlow } from './flow-graph';

describe('FlowEditorComponent', () => {
  let emitted: string[];

  beforeEach(async () => {
    emitted = [];
    await TestBed.configureTestingModule({
      imports: [FlowEditorComponent],
    }).compileComponents();
  });

  function make(code: string): ComponentFixture<FlowEditorComponent> {
    const fixture = TestBed.createComponent(FlowEditorComponent);
    fixture.componentRef.setInput('code', code);
    fixture.componentInstance.codeChange.subscribe((value) => {
      emitted.push(value);
      fixture.componentRef.setInput('code', value);
    });
    fixture.autoDetectChanges();
    return fixture;
  }

  function el(fixture: ComponentFixture<FlowEditorComponent>): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  async function settled(fixture: ComponentFixture<FlowEditorComponent>): Promise<void> {
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  function pointer(type: string, x: number, y: number): Event {
    return new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  }

  it('renders nodes from the code and lays out unpositioned ones', async () => {
    const fixture = make('flowchart TD\nA[Draft] --> B{Review}');
    await settled(fixture);

    const nodes = [...el(fixture).querySelectorAll('.flow-node')];
    expect(nodes.length).toBe(2);
    // Dagre put them somewhere sensible: distinct, on-canvas positions.
    const lefts = nodes.map((node) => Number((node as HTMLElement).style.left.replace('px', '')));
    expect(lefts[0]).not.toBe(lefts[1]);
    expect(el(fixture).querySelector('.flow-error')).toBeNull();
  });

  it('add node emits the new node and its position pin', async () => {
    const fixture = make('flowchart TD\nA[Start]');
    await settled(fixture);

    el(fixture).querySelector<HTMLButtonElement>('.flow-toolbar .action')!.click();
    await settled(fixture);

    expect(emitted.length).toBe(1);
    expect(emitted[0]).toContain('B[New]');
    expect(emitted[0]).toContain('%% composer: B');
  });

  it('dragging a node moves it and emits the position on drop', async () => {
    const fixture = make('flowchart TD\nA[Start] --> B[End]');
    await settled(fixture);

    const node = el(fixture).querySelector<HTMLElement>('.flow-node')!;
    const before = Number(node.style.left.replace('px', ''));
    const canvas = el(fixture).querySelector<HTMLElement>('.canvas')!;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600));

    node.dispatchEvent(pointer('pointerdown', before + 10, 10));
    canvas.dispatchEvent(pointer('pointermove', before + 10 + 55, 10 + 40));
    canvas.dispatchEvent(pointer('pointerup', before + 10 + 55, 10 + 40));
    await settled(fixture);

    const after = Number(node.style.left.replace('px', ''));
    expect(after).toBe(before + 55);
    expect(emitted.at(-1)).toContain(`%% composer: A ${before + 55},`);
  });

  it('connecting two nodes emits the edge; dropping elsewhere does not', async () => {
    const fixture = make('flowchart TD\nA[Start]\nB[End]');
    await settled(fixture);

    const nodes = [...el(fixture).querySelectorAll<HTMLElement>('.flow-node')];
    const canvas = el(fixture).querySelector<HTMLElement>('.canvas')!;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600));
    // jsdom has no elementFromPoint; the drop hit-test needs it.
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      writable: true,
      value: () => null,
    });
    const hit = vi.spyOn(document, 'elementFromPoint').mockReturnValue(nodes[1]!);

    const source = nodes[0]!;
    source.dispatchEvent(pointer('pointerdown', 40, 40)); // select + no-op drag start? handle below
    // The handle starts the connection.
    const handle = source.querySelector<HTMLElement>('.handle')!;
    handle.dispatchEvent(pointer('pointerdown', 40, 40));
    canvas.dispatchEvent(pointer('pointermove', 200, 200));
    canvas.dispatchEvent(pointer('pointerup', 200, 200));
    await settled(fixture);

    // The edge exists in the emitted code (shapes ride undeclared nodes).
    const graph = parseFlow(emitted.at(-1)!);
    expect(graph.edges).toContainEqual({ from: 'A', to: 'B', label: '' });
    expect(hit).toHaveBeenCalled();

    // Dropping on nothing cancels quietly.
    hit.mockReturnValue(null);
    const handle2 = source.querySelector<HTMLElement>('.handle')!;
    handle2.dispatchEvent(pointer('pointerdown', 40, 40));
    canvas.dispatchEvent(pointer('pointerup', 5, 5));
    await settled(fixture);
    expect(emitted.length).toBe(1);
  });

  it('relabeling a selected node rewrites its token', async () => {
    const fixture = make('flowchart TD\nA[Start] --> B[End]');
    await settled(fixture);

    const node = el(fixture).querySelector<HTMLElement>('.flow-node')!;
    node.dispatchEvent(pointer('pointerdown', 10, 10)); // select
    await settled(fixture);

    const input = el(fixture).querySelector<HTMLInputElement>('.field')!;
    input.value = 'Kickoff';
    input.dispatchEvent(new Event('input'));
    await settled(fixture);

    expect(emitted.at(-1)).toContain('A[Kickoff]');
  });

  it('a parse failure shows the error and keeps the canvas inert', async () => {
    const fixture = make('flowchart TD\nA -.-> B');
    await settled(fixture);

    const error = el(fixture).querySelector('.flow-error');
    expect(error).toBeTruthy();
    expect(el(fixture).querySelector('.canvas')?.classList.contains('error')).toBe(true);
    // No emission: the code is untouched by the refusal.
    expect(emitted.length).toBe(0);
  });
});
