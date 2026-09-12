import { Injectable, computed, inject, signal } from '@angular/core';

import { EventsClient } from '../core/events/events-client';
import { EventDeduper } from '../core/events/dedupe-events';
import { DomainEventJson, DiagramJson, domainEventKind } from '../core/events/wire';
import { Diagram, DiagramViewportData } from '../core/models/diagram.models';
import { ShellService } from '../shell/shell.service';

/**
 * The project's saved diagrams (Phase 11): a fold of the event stream
 * (diagramSaved, diagramDeleted). Content rides the events — the diagrams
 * are database truth, so the fold is the source and the snapshot replays
 * them on connect. Commands publish over the transport; the server
 * validates and a rejection surfaces here for the canvas to show.
 */
@Injectable({ providedIn: 'root' })
export class DiagramService {
  private readonly events = inject(EventsClient);
  private readonly dedupe = new EventDeduper();
  private readonly shell = inject(ShellService);

  private readonly diagramsByProject = signal<ReadonlyMap<string, readonly Diagram[]>>(new Map());

  readonly rejection = signal<string | null>(null);

  private readonly projectId = computed(() => this.shell.activeTabId());

  /** The active project's diagrams, in id order. */
  readonly diagrams = computed(
    () => this.diagramsByProject().get(this.projectId() ?? '') ?? [],
  );

  /** One project's diagrams, in id order (a tab reads its own project). */
  diagramsOf(projectId: string): readonly Diagram[] {
    return this.diagramsByProject().get(projectId) ?? [];
  }

  constructor() {
    this.events.events$.subscribe((event) => this.fold(event));
  }

  /** Saves a diagram; `ok` is false only on a server rejection. */
  async save(projectId: string, diagram: Diagram): Promise<{ ok: boolean; diagramId?: string }> {
    const response = await this.events.publish({
      projectId,
      requestDiagramSave: { diagram: diagram.toWire() },
    });
    if (!response.ok) {
      this.rejection.set(response.rejectionMessage ?? 'the server refused the request');
      return { ok: false };
    }
    this.rejection.set(null);
    return { ok: true, ...(response.diagramId !== undefined ? { diagramId: response.diagramId } : {}) };
  }

  /** Deletes a diagram; `ok` is false only on a server rejection. */
  async remove(projectId: string, diagramId: string): Promise<boolean> {
    const response = await this.events.publish({
      projectId,
      requestDiagramDelete: { diagramId },
    });
    if (!response.ok) {
      this.rejection.set(response.rejectionMessage ?? 'the server refused the request');
      return false;
    }
    this.rejection.set(null);
    return true;
  }

  /**
   * The debounced viewport-only save (pan/zoom): rides alone so panning
   * never collides with a content save and never trips the client's
   * unsaved-changes warning.
   */
  async saveViewport(
    projectId: string,
    diagramId: string,
    viewport: DiagramViewportData,
  ): Promise<boolean> {
    const response = await this.events.publish({
      projectId,
      requestDiagramViewport: { diagramId, viewport },
    });
    if (!response.ok) {
      this.rejection.set(response.rejectionMessage ?? 'the server refused the request');
      return false;
    }
    return true;
  }

  private fold(event: DomainEventJson): void {
    if (!this.dedupe.first(event)) return;
    const projectId = event.projectId ?? '';
    switch (domainEventKind(event)) {
      case 'diagramSaved': {
        const json = event.diagramSaved?.diagram as DiagramJson | undefined;
        if (!json?.id) break;
        const diagram = Diagram.fromWire(json);
        this.diagramsByProject.update((map) => {
          const existing = map.get(projectId) ?? [];
          const next = new Map(map);
          next.set(projectId, sortDiagrams([
            ...existing.filter((entry) => entry.id !== diagram.id),
            diagram,
          ]));
          return next;
        });
        break;
      }
      case 'diagramDeleted': {
        const diagramId = event.diagramDeleted?.diagramId;
        if (!diagramId) break;
        this.diagramsByProject.update((map) => {
          const existing = map.get(projectId) ?? [];
          const next = new Map(map);
          next.set(projectId, existing.filter((entry) => entry.id !== diagramId));
          return next;
        });
        break;
      }
      case 'diagramViewportChanged': {
        const change = event.diagramViewportChanged;
        if (!change?.diagramId) break;
        this.diagramsByProject.update((map) => {
          const existing = map.get(projectId) ?? [];
          const next = new Map(map);
          next.set(
            projectId,
            existing.map((entry) =>
              entry.id === change.diagramId ? entry.with({ viewport: change.viewport }) : entry,
            ),
          );
          return next;
        });
        break;
      }
    }
  }
}

/** Newest first (falls back to id for locally-created, un-echoed drafts). */
function sortDiagrams(diagrams: readonly Diagram[]): Diagram[] {
  return [...diagrams].sort(
    (a, b) =>
      (b.updatedAt || '').localeCompare(a.updatedAt || '') || a.id.localeCompare(b.id),
  );
}