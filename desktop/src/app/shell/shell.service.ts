import { Injectable, computed, inject, signal } from '@angular/core';

import { EventsClient } from '../core/events/events-client';
import { DomainEventJson, domainEventKind } from '../core/events/wire';

export interface ProjectTab {
  id: string;
  name: string;
  directory: string | null;
}

/**
 * Shell-wide state: project tabs, active tab, status-strip info.
 *
 * The tab list is a fold of project events (ProjectCreated / ProjectActivated)
 * over the Events gRPC stream and persists across restarts; the "+"
 * publishes RequestProjectCreate and the tab lands via its echo. Closing a tab
 * only hides it locally — there is no project-delete command in the catalog.
 */
@Injectable({ providedIn: 'root' })
export class ShellService {
  private readonly events = inject(EventsClient);

  private readonly projects = signal<readonly ProjectTab[]>([]);
  private readonly closedIds = signal<ReadonlySet<string>>(new Set());
  private pendingActivation: string | null = null;

  readonly tabs = computed(() => this.projects().filter((t) => !this.closedIds().has(t.id)));
  readonly activeTabId = signal<string | null>(null);
  readonly activeTab = computed(
    () => this.tabs().find((t) => t.id === this.activeTabId()) ?? null,
  );

  /** Active planner model shown in the top bar and status strip. */
  readonly model = signal('qwen3.6');

  constructor() {
    this.events.events$.subscribe((event) => this.fold(event));
  }

  /**
   * Top-bar "+": pick a directory (optional) and publish
   * `requestProjectCreate` — the tab lands via the projectCreated echo.
   */
  async addTab(): Promise<void> {
    const selection = await window.composer?.projects?.pickDirectory();
    if (!selection || !selection.name.trim()) return;
    await this.events.publish({
      projectId: '',
      requestProjectCreate: {
        name: selection.name,
        ...(selection.directory.trim() ? { directory: selection.directory } : {}),
      },
    });
  }

  async linkDirectory(id: string): Promise<void> {
    if (!this.projects().some((project) => project.id === id)) return;
    const selection = await window.composer?.projects?.pickDirectory();
    if (!selection?.directory.trim()) return;
    await this.events.publish({
      projectId: id,
      requestProjectSetDirectory: { projectId: id, directory: selection.directory },
    });
  }

  activateTab(id: string): void {
    if (!this.tabs().some((t) => t.id === id)) return;
    if (this.activeTabId() !== id) {
      this.activeTabId.set(id);
      void this.events.publish({
        projectId: id,
        requestProjectActivate: { projectId: id },
      });
    }
  }

  closeTab(id: string): void {
    const tabs = this.tabs();
    const index = tabs.findIndex((t) => t.id === id);
    if (index === -1) return;

    this.closedIds.update((ids) => new Set(ids).add(id));

    if (this.activeTabId() === id) {
      const remaining = this.tabs();
      const neighbor = remaining[Math.min(index, remaining.length - 1)];
      this.activeTabId.set(null);
      if (neighbor) this.activateTab(neighbor.id);
    }
  }

  private fold(event: DomainEventJson): void {
    switch (domainEventKind(event)) {
      case 'projectCreated': {
        const project = event.projectCreated?.project;
        if (!project?.id || !project.name) break;
        const tab: ProjectTab = {
          id: project.id,
          name: project.name,
          directory: project.directory?.trim() || null,
        };
        this.projects.update((projects) =>
          projects.some((item) => item.id === tab.id)
            ? projects.map((item) => (item.id === tab.id ? tab : item))
            : [...projects, tab],
        );
        // Startup snapshots carry no activation; land on the first project
        // (or the one just opened via "+").
        if (this.activeTabId() === null) {
          const target = this.pendingActivation ?? tab.id;
          if (this.pendingActivation === tab.id) this.pendingActivation = null;
          this.activeTabId.set(target);
        }
        break;
      }
      case 'projectDirectoryChanged': {
        const payload = event.projectDirectoryChanged;
        if (!payload?.projectId || !payload.directory) break;
        this.projects.update((projects) =>
          projects.map((project) =>
            project.id === payload.projectId
              ? { ...project, directory: payload.directory ?? null }
              : project,
          ),
        );
        break;
      }
      case 'projectActivated': {
        const id = event.projectActivated?.projectId;
        if (id && this.tabs().some((t) => t.id === id)) this.activeTabId.set(id);
        break;
      }
    }
  }
}
