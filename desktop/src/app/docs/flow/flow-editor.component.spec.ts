import { ComponentFixture, TestBed } from "@angular/core/testing";
import {
  FCreateConnectionEvent,
  FMoveNodesEvent,
  FSelectionChangeEvent,
} from "@foblex/flow";

import { FlowEditorComponent } from "./flow-editor.component";
import { parseFlow } from "./flow-graph";

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

(globalThis as Record<string, unknown>)["ResizeObserver"] ??=
  ResizeObserverStub;

describe("FlowEditorComponent", () => {
  let emitted: string[];

  beforeEach(async () => {
    emitted = [];
    await TestBed.configureTestingModule({
      imports: [FlowEditorComponent],
    }).compileComponents();
  });

  function make(code: string): ComponentFixture<FlowEditorComponent> {
    const fixture = TestBed.createComponent(FlowEditorComponent);
    fixture.componentRef.setInput("code", code);
    fixture.componentInstance.codeChange.subscribe((value) => {
      emitted.push(value);
      fixture.componentRef.setInput("code", value);
    });
    fixture.autoDetectChanges();
    return fixture;
  }

  function el(fixture: ComponentFixture<FlowEditorComponent>): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  async function settled(
    fixture: ComponentFixture<FlowEditorComponent>,
  ): Promise<void> {
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  function selectNodes(
    fixture: ComponentFixture<FlowEditorComponent>,
    ...nodeIds: string[]
  ): void {
    const component = fixture.componentInstance as unknown as {
      selectionChanged(event: FSelectionChangeEvent): void;
    };
    component.selectionChanged(new FSelectionChangeEvent(nodeIds, [], []));
  }

  it("renders parsed nodes through Foblex", async () => {
    const fixture = make("flowchart TD\nA[Draft] --> B{Review}");
    await settled(fixture);

    expect(el(fixture).querySelectorAll(".flow-node").length).toBe(2);
    expect(el(fixture).querySelectorAll("f-connection").length).toBe(1);
    expect(el(fixture).querySelector(".flow-error")).toBeNull();
  });

  it("adds a node and persists its position", async () => {
    const fixture = make("flowchart TD\nA[Start]");
    await settled(fixture);

    el(fixture).querySelector<HTMLButtonElement>(".add-node")!.click();
    await settled(fixture);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain("B[New]");
    expect(emitted[0]).toContain("%% composer: node B");
  });

  it("persists final positions emitted by Foblex", async () => {
    const fixture = make("flowchart TD\nA[Start] --> B[End]");
    await settled(fixture);
    const component = fixture.componentInstance as unknown as {
      moveItems(event: FMoveNodesEvent): void;
    };

    component.moveItems(
      new FMoveNodesEvent([{ id: "A", position: { x: 315, y: 145 } }]),
    );
    await settled(fixture);

    expect(emitted.at(-1)).toContain("%% composer: node A 315,145");
  });

  it("creates connections from Foblex connector events", async () => {
    const fixture = make("flowchart TD\nA[Start]\nB[End]");
    await settled(fixture);
    const component = fixture.componentInstance as unknown as {
      createConnection(event: FCreateConnectionEvent): void;
    };

    component.createConnection(
      new FCreateConnectionEvent("A:source", "B:target", { x: 200, y: 200 }),
    );
    await settled(fixture);

    expect(parseFlow(emitted.at(-1)!).edges).toContainEqual({
      from: "A",
      to: "B",
      label: "",
    });
  });

  it("edits a node label, type, and description", async () => {
    const fixture = make("flowchart TD\nA[Start]");
    await settled(fixture);
    selectNodes(fixture, "A");
    await settled(fixture);

    const host = el(fixture);
    const values: Array<[string, string]> = [
      [".label-field", "Gateway"],
      [".type-field", "service"],
      [".description-field", "Routes requests"],
    ];
    for (const [selector, value] of values) {
      const input = host.querySelector<HTMLInputElement>(selector)!;
      input.value = value;
      input.dispatchEvent(new Event("input"));
    }
    await settled(fixture);

    const node = parseFlow(emitted.at(-1)!).nodes[0]!;
    expect(node).toMatchObject({
      label: "Gateway",
      type: "service",
      description: "Routes requests",
    });
  });

  it("groups the selected nodes and emits a Mermaid subgraph", async () => {
    const fixture = make("flowchart TD\nA[Start] --> B[End]");
    await settled(fixture);
    selectNodes(fixture, "A", "B");

    el(fixture).querySelector<HTMLButtonElement>(".add-group")!.click();
    await settled(fixture);

    const graph = parseFlow(emitted.at(-1)!);
    expect(graph.groups).toHaveLength(1);
    expect(
      graph.nodes.every((node) => node.groupId === graph.groups[0]!.id),
    ).toBe(true);
    expect(emitted.at(-1)).toContain('subgraph Group1["Group"]');
  });

  it("shows unsupported syntax without changing the document", async () => {
    const fixture = make("flowchart TD\nA -.-> B");
    await settled(fixture);

    expect(el(fixture).querySelector(".flow-error")).toBeTruthy();
    expect(
      el(fixture).querySelector(".canvas")?.classList.contains("error"),
    ).toBe(true);
    expect(emitted).toHaveLength(0);
  });
});
