import { ComponentFixture, TestBed } from "@angular/core/testing";

import {
  FakeEventsClient,
  provideFakeEventsClient,
  wireEvent,
} from "../core/events/events-client.fake";
import { ShellService } from "../shell/shell.service";
import { CanvasComponent } from "./canvas.component";

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as Record<string, unknown>)["ResizeObserver"] ??=
  ResizeObserverStub;

describe("CanvasComponent", () => {
  let events: FakeEventsClient;

  beforeEach(async () => {
    events = new FakeEventsClient();
    await TestBed.configureTestingModule({
      imports: [CanvasComponent],
      providers: [provideFakeEventsClient(events)],
    }).compileComponents();
  });

  function make(): ComponentFixture<CanvasComponent> {
    const fixture = TestBed.createComponent(CanvasComponent);
    fixture.autoDetectChanges();
    return fixture;
  }

  function el(fixture: ComponentFixture<CanvasComponent>): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  /** Subscribe the shell to the stream first, then create + activate the tab. */
  const activate = (projectId: string): void => {
    const shell = TestBed.inject(ShellService);
    events.emit(
      wireEvent(
        "projectCreated",
        {
          project: { id: projectId, name: projectId, createdAt: "" },
        },
        projectId,
      ),
    );
    shell.activateTab(projectId);
  };

  const seedDiagram = (
    diagram: Record<string, unknown>,
    projectId = "P-1",
  ): void => {
    events.emit(
      wireEvent(
        "diagramSaved",
        {
          diagram: { projectId, updatedAt: "", ...diagram },
        },
        projectId,
      ),
    );
  };

  const openSaved = async (
    fixture: ComponentFixture<CanvasComponent>,
    diagram: Record<string, unknown>,
  ): Promise<void> => {
    seedDiagram({ id: "DG-1", name: "Request flow", nodes: [], edges: [], groups: [], ...diagram });
    await fixture.whenStable();
    (
      el(fixture).querySelectorAll(".diagram-entry")[0] as HTMLElement
    ).click();
    await fixture.whenStable();
  };

  it("shows an empty call to action before any diagram exists", async () => {
    const fixture = make();
    await fixture.whenStable();

    expect(el(fixture).querySelector(".empty-state")).not.toBeNull();
  });

  it("lists and opens a saved diagram into the canvas", async () => {
    activate("P-1");
    const fixture = make();
    await fixture.whenStable();

    await openSaved(fixture, {
      nodes: [
        {
          id: "A",
          type: "screen",
          label: "start",
          description: "",
          groupId: null,
          x: 0,
          y: 0,
          w: 96,
          h: 46,
        },
      ],
    });

    expect(el(fixture).querySelectorAll(".diagram-entry").length).toBe(1);
    expect(el(fixture).querySelectorAll(".flow-node").length).toBe(1);
    // The type is presentation: the node renders with its type class.
    expect(el(fixture).querySelector(".node-shape.type-screen")).not.toBeNull();
  });

  it("creating a diagram publishes a save and adopts the allocated id", async () => {
    activate("P-1");
    events.respondWith({ ok: true, diagramId: "DG-7" });

    const fixture = make();
    await fixture.whenStable();

    (
      el(fixture).querySelector('[aria-label="new diagram"]') as HTMLElement
    ).click();
    await fixture.whenStable();

    expect(events.lastCommand("requestDiagramSave")?.projectId).toBe("P-1");

    // The server echoes the save; the fold lands the diagram and the editor opens.
    events.emit(
      wireEvent("diagramSaved", {
        diagram: {
          id: "DG-7",
          projectId: "P-1",
          name: "Untitled",
          nodes: [],
          edges: [],
        },
      }),
    );
    await fixture.whenStable();

    expect(el(fixture).querySelector(".name-field")).not.toBeNull();
  });

  it("a save echo never wipes the working copy", async () => {
    activate("P-1");
    events.respondWith({ ok: true, diagramId: "DG-7" });
    const fixture = make();
    await fixture.whenStable();

    (
      el(fixture).querySelector('[aria-label="new diagram"]') as HTMLElement
    ).click();
    await fixture.whenStable();
    events.emit(
      wireEvent("diagramSaved", {
        diagram: {
          id: "DG-7",
          projectId: "P-1",
          name: "Untitled",
          nodes: [],
          edges: [],
        },
      }),
    );
    await fixture.whenStable();

    // A local rename lands in the working copy…
    const nameField =
      el(fixture).querySelector<HTMLInputElement>(".name-field")!;
    nameField.value = "Local name";
    nameField.dispatchEvent(new Event("input"));
    await fixture.whenStable();

    // …and a re-echo of the same diagram (an old-name save, say) must not revert it.
    events.emit(
      wireEvent("diagramSaved", {
        diagram: {
          id: "DG-7",
          projectId: "P-1",
          name: "Untitled",
          nodes: [],
          edges: [],
        },
      }),
    );
    await fixture.whenStable();

    expect(
      (el(fixture).querySelector(".name-field") as HTMLInputElement).value,
    ).toBe("Local name");
    // …and the edit is still unpublished (dirty), not silently saved over.
    expect(events.lastCommand("requestDiagramSave")?.projectId).toBe("P-1");
    const saves = events.published.filter(
      (c) => FakeEventsClient.commandKind(c) === "requestDiagramSave",
    );
    expect(saves.length).toBe(1);
  });

  it("a diagram deleted from elsewhere closes the editor", async () => {
    activate("P-1");
    const fixture = make();
    await fixture.whenStable();

    events.emit(
      wireEvent("diagramSaved", {
        diagram: {
          id: "DG-1",
          projectId: "P-1",
          name: "Ghost",
          nodes: [],
          edges: [],
        },
      }),
    );
    await fixture.whenStable();
    (el(fixture).querySelectorAll(".diagram-entry")[0] as HTMLElement).click();
    await fixture.whenStable();
    expect(el(fixture).querySelector(".name-field")).not.toBeNull();

    events.emit(wireEvent("diagramDeleted", { diagramId: "DG-1" }));
    await fixture.whenStable();

    expect(el(fixture).querySelector(".empty-state")).not.toBeNull();
  });

  it("adding a node and saving publishes the working copy", async () => {
    activate("P-1");
    events.respondWith({ ok: true, diagramId: "DG-7" });
    const fixture = make();
    await fixture.whenStable();

    (
      el(fixture).querySelector('[aria-label="new diagram"]') as HTMLElement
    ).click();
    await fixture.whenStable();
    events.emit(
      wireEvent("diagramSaved", {
        diagram: {
          id: "DG-7",
          projectId: "P-1",
          name: "Untitled",
          nodes: [],
          edges: [],
        },
      }),
    );
    await fixture.whenStable();

    (
      el(fixture).querySelector('[aria-label="add node"]') as HTMLElement
    ).click();
    await fixture.whenStable();
    (el(fixture).querySelector("button.save") as HTMLElement).click();
    await fixture.whenStable();

    const save = events.lastCommand("requestDiagramSave");
    const body = (
      save as unknown as {
        requestDiagramSave: { diagram: { nodes: unknown[] } };
      }
    ).requestDiagramSave.diagram;
    expect(body.nodes.length).toBe(1);
  });

  it("the right-click menu adds a typed node at the pointer and opens the panel", async () => {
    activate("P-1");
    const fixture = make();
    await fixture.whenStable();
    await openSaved(fixture, { nodes: [], edges: [] });

    const flow = el(fixture).querySelector("f-flow")!;
    flow.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 300,
        clientY: 200,
      }),
    );
    await fixture.whenStable();

    const menu = el(fixture).querySelector(".context-menu");
    expect(menu).not.toBeNull();

    (menu!.querySelectorAll("button")[0] as HTMLElement).click();
    await fixture.whenStable();

    // The node lands as a screen (presentation class) with the panel open.
    expect(el(fixture).querySelector(".node-shape.type-screen")).not.toBeNull();
    expect(el(fixture).querySelector(".detail-panel")).not.toBeNull();
    const select = el(fixture).querySelector<HTMLSelectElement>(".detail-panel select");
    expect(select?.value).toBe("screen");
  });

  it("the detail panel edits a node description and the save carries it", async () => {
    activate("P-1");
    const fixture = make();
    await fixture.whenStable();
    await openSaved(fixture, {
      nodes: [
        {
          id: "A",
          type: "screen",
          label: "Home",
          description: "",
          groupId: null,
          x: 10,
          y: 10,
          w: 96,
          h: 46,
        },
      ],
      edges: [],
    });

    // A single click selects the node and opens the right-side detail panel.
    (
      fixture.componentInstance as unknown as {
        selectionChanged(event: unknown): void;
      }
    ).selectionChanged({ nodeIds: ["A"], groupIds: [], connectionIds: [] });
    await fixture.whenStable();

    const textarea = el(fixture).querySelector<HTMLTextAreaElement>(
      '[aria-label="node description"]',
    )!;
    expect(textarea).not.toBeNull();
    textarea.value = "the landing page a signed-in user sees";
    textarea.dispatchEvent(new Event("input"));
    await fixture.whenStable();

    (el(fixture).querySelector("button.save") as HTMLElement).click();
    await fixture.whenStable();

    const save = events.lastCommand(
      "requestDiagramSave",
    ) as unknown as { requestDiagramSave: { diagram: { nodes: Array<Record<string, unknown>> } } };
    expect(save.requestDiagramSave.diagram.nodes[0]).toMatchObject({
      id: "A",
      type: "screen",
      description: "the landing page a signed-in user sees",
    });
  });

  it("panning never marks the working copy dirty", async () => {
    activate("P-1");
    const fixture = make();
    await fixture.whenStable();
    await openSaved(fixture, { nodes: [], edges: [] });

    const component = fixture.componentInstance as unknown as {
      dirty(): boolean;
      canvasChanged(event: { position: { x: number; y: number }; scale: number }): void;
    };
    expect(component.dirty()).toBe(false);

    component.canvasChanged({ position: { x: -40, y: 25 }, scale: 1.5 });
    // The viewport-only save is debounced (600ms) — a pan burst collapses.
    await new Promise((resolve) => setTimeout(resolve, 750));

    // The viewport-only save flew (pan persists)…
    const viewports = events.published.filter(
      (c) => FakeEventsClient.commandKind(c) === "requestDiagramViewport",
    );
    expect(viewports.length).toBe(1);
    // …but the working copy stays clean: no unsaved-content warning, and a
    // content save is not marked as needed either.
    expect(component.dirty()).toBe(false);
    const saves = events.published.filter(
      (c) => FakeEventsClient.commandKind(c) === "requestDiagramSave",
    );
    expect(saves.length).toBe(0);
  });

  it("restores the last viewport when reopening a diagram", async () => {
    activate("P-1");
    const fixture = make();
    await fixture.whenStable();
    await openSaved(fixture, {
      nodes: [],
      edges: [],
      viewport: { x: -120, y: 40, scale: 0.8 },
    });

    const component = fixture.componentInstance as unknown as {
      viewport(): { x: number; y: number; scale: number };
    };
    expect(component.viewport()).toEqual({ x: -120, y: 40, scale: 0.8 });
  });
});
