import { Injectable, computed, inject, signal } from '@angular/core';

import { DirectoryPickerService } from '../core/directory-picker/directory-picker.service';
import { EventsClient } from '../core/events/events-client';
import { DomainEventJson, domainEventKind } from '../core/events/wire';
import { ProjectTabReuseStrategy } from './project-tab-reuse';

export interface ProjectTab {
  id: string;
  name: string;
  directory: string | null;
  archivedAt: string | null;
}

/**
 * Shell-wide state: projects, the open tabs, the active workspace context,
 * status-strip info.
 *
 * Project lists are a fold of lifecycle events over the event stream and
 * persist across restarts. Archive hides a project without deleting its
 * state. Tabs: several projects can be open at once (browser-style) —
 * `openTabIds` is the session's strip order and `activeTabId` the one on
 * screen; the reuse strategy keeps each tab's views alive in between.
 */
@Injectable({ providedIn: 'root' })
export class ShellService {
  private static readonly LAST_VIEWS_KEY = 'composer.last-project-views';
  private static readonly OPEN_TABS_KEY = 'composer.open-project-tabs';
  private readonly events = inject(EventsClient);
  private readonly directoryPicker = inject(DirectoryPickerService);
  private readonly reuse = inject(ProjectTabReuseStrategy);

  private readonly projects = signal<readonly ProjectTab[]>([]);
  private pendingActivation: string | null = null;
  /** The strip's open tabs, in open order (a session lives across views). */
  private readonly openIds = signal<readonly string[]>([]);
  /** The stored startup state, read lazily on the first folded project. */
  private storedTabs: { openIds: readonly string[]; activeId: string | null } | null | undefined = undefined;

  /** Set while a tab close is navigating away — the unsaved-work guards
   * confirm only then (an ordinary tab switch keeps the detached view). */
  private tabCloseInFlight = false;
  private pendingTabClose: { id: string; wasActive: boolean; nextId: string | null } | null = null;

  readonly activeProjects = computed(() =>
    this.projects().filter((project) => !project.archivedAt),
  );
  readonly tabs = this.activeProjects;
  readonly archivedProjects = computed(() =>
    this.projects().filter((project) => project.archivedAt !== null),
  );
  readonly activeTabId = signal<string | null>(null);
  readonly activeTab = computed(() => this.tabs().find((t) => t.id === this.activeTabId()) ?? null);
  /** The strip's tabs: the projects opened this session, in open order. */
  readonly openTabs = computed(() =>
    this.openIds()
      .map((id) => this.tabs().find((project) => project.id === id))
      .filter((project): project is ProjectTab => project !== undefined),
  );

  private readonly lastViews = readLastViews();

  constructor() {
    this.events.events$.subscribe((event) => this.fold(event));
  }

  /**
   * Top-bar "+": pick a server-side directory and publish
   * `requestProjectCreate` — the tab lands via the projectCreated echo.
   */
  async addTab(): Promise<void> {
    const selection = await this.directoryPicker.pick();
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
    const project = this.projects().find((candidate) => candidate.id === id);
    if (project === undefined) return;
    const selection = await this.directoryPicker.pick(project.directory);
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
    // A deep link (or a dashboard click) opens the tab it lands on.
    if (!this.openIds().includes(id)) {
      this.openIds.update((ids) => [...ids, id]);
      this.persistTabs();
    }
  }

  /**
   * Opens a project as a tab (registering it in the strip) and activates
   * it; returns the URL its workspace lives at.
   */
  openProject(id: string): string {
    if (!this.tabs().some((t) => t.id === id)) return '/dashboard';
    if (!this.openIds().includes(id)) {
      this.openIds.update((ids) => [...ids, id]);
      this.persistTabs();
    }
    this.activateTab(id);
    return this.workspaceUrl(id);
  }

  /**
   * Arms a tab close: the guards confirm only now (the tab's detached
   * views are dropped — ordinary navigation keeps them). Returns the URL
   * to navigate to, or null when no navigation is needed (an inactive tab
   * closes invisibly). Pair with `completeTabClose(committed)`.
   */
  beginTabClose(id: string): string | null {
    if (!this.openIds().includes(id)) return null;
    const wasActive = this.activeTabId() === id;
    const nextId = wasActive
      ? (this.openIds().filter((candidate) => candidate !== id).at(-1) ?? null)
      : null;
    this.tabCloseInFlight = true;
    this.pendingTabClose = { id, wasActive, nextId };
    if (!wasActive) {
      // The tab's views are detached: no route deactivates, no guard runs.
      this.completeTabClose(true);
      return null;
    }
    return nextId ? this.workspaceUrl(nextId) : '/dashboard';
  }

  /** Settles the armed close: `committed` false rolls everything back. */
  completeTabClose(committed: boolean): void {
    const pending = this.pendingTabClose;
    this.tabCloseInFlight = false;
    this.pendingTabClose = null;
    if (!pending || !committed) return;
    this.openIds.update((ids) => ids.filter((candidate) => candidate !== pending.id));
    this.reuse.discard(pending.id);
    if (pending.wasActive) {
      if (pending.nextId !== null) this.activateTab(pending.nextId);
      else this.activeTabId.set(null);
    }
    this.persistTabs();
  }

  /** True while a tab close is navigating away (the guards' trigger). */
  get closingTab(): boolean {
    return this.tabCloseInFlight;
  }

  /** The last coding-workflow location for a project, with a safe board fallback. */
  workspaceUrl(id: string): string {
    const suffix = this.lastViews[id] ?? 'coding/board';
    return `/projects/${encodeURIComponent(id)}/${suffix}`;
  }

  rememberWorkspaceUrl(url: string): void {
    const path = url.split(/[?#]/, 1)[0];
    const match = path.match(
      /^\/projects\/([^/]+)\/(coding\/(?:board|plan|docs|pipelines|coding|canvas|run\/[^/]+))$/,
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

  /** Persists the open tabs + the active one (the next startup restores them). */
  private persistTabs(): void {
    try {
      browserStorage()?.setItem(
        ShellService.OPEN_TABS_KEY,
        JSON.stringify({ openIds: this.openIds(), activeId: this.activeTabId() }),
      );
    } catch {
      // The strip still works when storage is unavailable.
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
        // (or the one just opened via "+"), then re-land on the stored
        // session's active tab once it folds in.
        if (tab.archivedAt !== null) break;
        const stored = readStoredTabs();
        if (this.activeTabId() === null) {
          const storedActiveKnown =
            stored?.activeId !== null && stored?.activeId !== undefined && this.tabs().some((t) => t.id === stored.activeId);
          const target = this.pendingActivation ?? (storedActiveKnown ? stored!.activeId! : tab.id);
          if (this.pendingActivation === tab.id) this.pendingActivation = null;
          this.activeTabId.set(target);
          const ids = new Set(this.openIds());
          ids.add(target);
          if (stored) for (const id of stored.openIds) if (this.tabs().some((t) => t.id === id)) ids.add(id);
          this.openIds.set([...ids]);
          this.persistTabs();
        } else {
          // The stored session's tabs (and its active tab) land as their
          // projects fold in — silently: no activation commands mid-replay.
          if (stored?.openIds.includes(tab.id) || stored?.activeId === tab.id) {
            this.openIds.update((ids) => (ids.includes(tab.id) ? ids : [...ids, tab.id]));
            this.persistTabs();
          }
          if (stored?.activeId === tab.id) this.activeTabId.set(tab.id);
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
        if (id && this.tabs().some((t) => t.id === id)) {
          this.activeTabId.set(id);
          if (!this.openIds().includes(id)) {
            this.openIds.update((ids) => [...ids, id]);
            this.persistTabs();
          }
        }
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
        if (this.openIds().includes(payload.projectId)) {
          this.openIds.update((ids) => ids.filter((candidate) => candidate !== payload.projectId));
          this.reuse.discard(payload.projectId);
          this.persistTabs();
        }
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
          /^coding\/(?:board|plan|docs|pipelines|coding|canvas|run\/[^/]+)$/.test(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

/** The stored startup state: which tab was last on screen. */
function readStoredTabs(): { openIds: readonly string[]; activeId: string | null } | null {
  try {
    const value = JSON.parse(browserStorage()?.getItem('composer.open-project-tabs') ?? 'null') as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as { openIds?: unknown; activeId?: unknown };
    if (!Array.isArray(record.openIds)) return null;
    const openIds = record.openIds.filter((id): id is string => typeof id === 'string');
    return {
      openIds,
      activeId: typeof record.activeId === 'string' ? record.activeId : null,
    };
  } catch {
    return null;
  }
}

function browserStorage(): Storage | undefined {
  // Node 22 exposes an unusable localStorage getter in the Angular test
  // process. Real browsers and the Electron renderer use the normal API.
  if ('process' in globalThis && !navigator.userAgent.includes('Electron/')) return undefined;
  return window.localStorage;
}
