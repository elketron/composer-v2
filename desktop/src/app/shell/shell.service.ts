import { Injectable, computed, inject, signal } from '@angular/core';

import { EventsClient } from '../core/events/events-client';
import { DomainEventJson, domainEventKind } from '../core/events/wire';

export interface ProjectTab {
  id: string;
  name: string;
  directory: string | null;
  archivedAt: string | null;
}

/**
 * Shell-wide state: projects, active workspace context, status-strip info.
 *
 * Project lists are a fold of lifecycle events over the event stream and
 * persist across restarts. Archive hides a project without deleting its state.
 */
@Injectable({ providedIn: 'root' })
export class ShellService {
  private static readonly LAST_VIEWS_KEY = 'composer.last-project-views';
  private readonly events = inject(EventsClient);

  private readonly projects = signal<readonly ProjectTab[]>([]);
  private pendingActivation: string | null = null;

  readonly activeProjects = computed(() =>
    this.projects().filter((project) => !project.archivedAt),
  );
  readonly tabs = this.activeProjects;
  readonly archivedProjects = computed(() =>
    this.projects().filter((project) => project.archivedAt !== null),
  );
  readonly activeTabId = signal<string | null>(null);
  readonly activeTab = computed(() => this.tabs().find((t) => t.id === this.activeTabId()) ?? null);

  /** Active planner model shown in the top bar and status strip. */
  readonly model = signal('qwen3.6');

  private readonly lastViews = readLastViews();

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
      requestProjectSetDirectory: {
        projectId: id,
        directory: selection.directory,
      },
    });
  }

  async archiveProject(id: string): Promise<string | null> {
    const response = await this.events.publish({
      projectId: id,
      requestProjectArchive: { projectId: id },
    });
    return response.ok ? null : (response.rejectionMessage ?? 'the project could not be archived');
  }

  async restoreProject(id: string): Promise<string | null> {
    const response = await this.events.publish({
      projectId: id,
      requestProjectRestore: { projectId: id },
    });
    return response.ok ? null : (response.rejectionMessage ?? 'the project could not be restored');
  }

  project(id: string): ProjectTab | undefined {
    return this.projects().find((project) => project.id === id);
  }

  /** Route context selects the project without emitting a redundant domain command. */
  selectProject(id: string): void {
    this.activeTabId.set(id);
  }

  /** The last coding-workflow location for a project, with a safe board fallback. */
  workspaceUrl(id: string): string {
    const suffix = this.lastViews[id] ?? 'coding/board';
    return `/projects/${encodeURIComponent(id)}/${suffix}`;
  }

  rememberWorkspaceUrl(url: string): void {
    const path = url.split(/[?#]/, 1)[0];
    const match = path.match(
      /^\/projects\/([^/]+)\/(coding\/(?:board|plan|pipelines|coding|run\/[^/]+))$/,
    );
    if (!match) return;
    const projectId = decodeURIComponent(match[1]);
    this.lastViews[projectId] = match[2];
    try {
      browserStorage()?.setItem(ShellService.LAST_VIEWS_KEY, JSON.stringify(this.lastViews));
    } catch {
      // Navigation still works when storage is unavailable.
    }
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

  private fold(event: DomainEventJson): void {
    switch (domainEventKind(event)) {
      case 'projectCreated': {
        const project = event.projectCreated?.project;
        if (!project?.id || !project.name) break;
        const tab: ProjectTab = {
          id: project.id,
          name: project.name,
          directory: project.directory?.trim() || null,
          archivedAt: project.archivedAt ?? null,
        };
        this.projects.update((projects) =>
          projects.some((item) => item.id === tab.id)
            ? projects.map((item) => (item.id === tab.id ? tab : item))
            : [...projects, tab],
        );
        // Startup snapshots carry no activation; land on the first project
        // (or the one just opened via "+").
        if (this.activeTabId() === null && tab.archivedAt === null) {
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
      case 'projectArchived': {
        const payload = event.projectArchived;
        if (!payload?.projectId) break;
        this.projects.update((projects) =>
          projects.map((project) =>
            project.id === payload.projectId
              ? { ...project, archivedAt: payload.archivedAt }
              : project,
          ),
        );
        if (this.activeTabId() === payload.projectId) this.activeTabId.set(null);
        break;
      }
      case 'projectRestored': {
        const projectId = event.projectRestored?.projectId;
        if (!projectId) break;
        this.projects.update((projects) =>
          projects.map((project) =>
            project.id === projectId ? { ...project, archivedAt: null } : project,
          ),
        );
        break;
      }
    }
  }
}

function readLastViews(): Record<string, string> {
  try {
    const value = JSON.parse(browserStorage()?.getItem('composer.last-project-views') ?? '{}') as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' &&
          /^coding\/(?:board|plan|pipelines|coding|run\/[^/]+)$/.test(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

function browserStorage(): Storage | undefined {
  // Node 22 exposes an unusable localStorage getter in the Angular test
  // process. Real browsers and the Electron renderer use the normal API.
  if ('process' in globalThis && !navigator.userAgent.includes('Electron/')) return undefined;
  return window.localStorage;
}
