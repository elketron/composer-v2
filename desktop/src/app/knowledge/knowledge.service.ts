import { Injectable, inject, signal } from '@angular/core';

import { EventsClient } from '../core/events/events-client';
import { ConfirmService } from '../core/confirm/confirm.service';
import { KnowledgeEntryInfoJson, DomainEventJson, domainEventKind } from '../core/events/wire';
import { RestClient } from '../core/rest';

/** One scored search hit. */
export interface KnowledgeSearchResult {
  path: string;
  title: string;
  tags: string[];
  score: number;
  snippet: string;
}

/**
 * The knowledge library's desktop state (Phase 9 S30): the list fold plus
 * REST reads and the knowledge commands. Files are the truth — `open()`
 * refreshes from the server (the view entry), `knowledgeSaved` /
 * `knowledgeDeleted` events keep the loaded list live in between.
 * `editingDirty` mirrors the pane's editor state for the route guard.
 */
@Injectable({ providedIn: 'root' })
export class KnowledgeService {
  private readonly events = inject(EventsClient);
  private readonly confirm = inject(ConfirmService);
  private readonly rest = inject(RestClient);

  private readonly index = signal<readonly KnowledgeEntryInfoJson[]>([]);
  private loaded = false;

  readonly entries = this.index.asReadonly();
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  /** The selected note's path (shared by the list and the pane). */
  readonly selected = signal<string | null>(null);
  /** view = read a note; edit = rework one; create = a brand-new note. */
  readonly mode = signal<'view' | 'edit' | 'create'>('view');
  /** The pane's unsaved-edits state (the assistant route's guard reads it). */
  readonly editingDirty = signal(false);

  constructor() {
    this.events.events$.subscribe((event) => this.fold(event));
  }

  /**
   * Selects a note (or null to clear). Unsaved edits confirm first;
   * false means the user kept editing.
   */
  async select(path: string | null): Promise<boolean> {
    if (path !== null && path === this.selected() && this.mode() === 'view') return true;
    if (!(await this.confirmDiscard())) return false;
    this.editingDirty.set(false);
    this.selected.set(path);
    this.mode.set('view');
    return true;
  }

  /** Opens create mode (the list's "+ new note"); unsaved edits confirm. */
  async beginCreate(): Promise<boolean> {
    if (!(await this.confirmDiscard())) return false;
    this.editingDirty.set(false);
    this.selected.set(null);
    this.mode.set('create');
    return true;
  }

  /** Unsaved work confirms before anything discards it. */
  async confirmDiscard(): Promise<boolean> {
    if (!this.editingDirty()) return true;
    return await this.confirm.confirm({
      title: 'Discard unsaved changes?',
      detail: 'the note has edits that were not saved yet',
      confirmLabel: 'discard',
      danger: true,
    });
  }

  /** Refreshes the index over REST; the fold keeps it live afterwards. */
  async open(): Promise<void> {
    if (this.rest.serverBase === null) return;
    this.loading.set(true);
    try {
      const response = await this.rest.get<{ entries?: unknown; error?: unknown }>(`/knowledge`);
      if (response === null) {
        this.error.set('could not reach the server');
        return;
      }
      if (!response.ok || typeof response.body.error === 'string') {
        this.error.set(
          typeof response.body.error === 'string' ? response.body.error : 'the knowledge library is unavailable',
        );
        return;
      }
      if (!Array.isArray(response.body.entries)) return;
      this.error.set(null);
      this.loaded = true;
      this.index.set(sanitize(response.body.entries));
    } finally {
      this.loading.set(false);
    }
  }

  /** One note's raw file text + parsed metadata. */
  async read(
    path: string,
  ): Promise<{ ok: true; content: string; body: string; title: string; tags: string[] } | { ok: false; error: string }> {
    if (this.rest.serverBase === null) return { ok: false, error: 'no server attached' };
    const response = await this.rest.get<{ entry?: { content?: unknown; body?: unknown; title?: unknown; tags?: unknown }; error?: unknown }>(
      `/knowledge/content?path=${encodeURIComponent(path)}`,
    );
    if (response === null) return { ok: false, error: 'could not reach the server' };
    if (!response.ok || typeof response.body.error === 'string') {
      return {
        ok: false,
        error: typeof response.body.error === 'string' ? response.body.error : `note '${path}' is unavailable`,
      };
    }
    if (typeof response.body.entry?.content !== 'string' || typeof response.body.entry?.body !== 'string') {
      return { ok: false, error: `note '${path}' is unavailable` };
    }
    return {
      ok: true,
      content: response.body.entry.content,
      body: response.body.entry.body,
      title: typeof response.body.entry.title === 'string' ? response.body.entry.title : path,
      tags: Array.isArray(response.body.entry.tags) ? response.body.entry.tags.filter((t): t is string => typeof t === 'string') : [],
    };
  }

  async search(query: string): Promise<readonly KnowledgeSearchResult[]> {
    if (this.rest.serverBase === null || query.trim() === '') return [];
    const response = await this.rest.get<{ results?: unknown }>(`/knowledge/search?q=${encodeURIComponent(query)}`);
    if (response === null || !Array.isArray(response.body.results)) return [];
    return response.body.results.flatMap((entry): KnowledgeSearchResult[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const hit = entry as Record<string, unknown>;
      if (typeof hit['path'] !== 'string') return [];
      return [{
        path: hit['path'],
        title: typeof hit['title'] === 'string' ? hit['title'] : hit['path'],
        tags: Array.isArray(hit['tags']) ? hit['tags'].filter((t): t is string => typeof t === 'string') : [],
        score: typeof hit['score'] === 'number' ? hit['score'] : 0,
        snippet: typeof hit['snippet'] === 'string' ? hit['snippet'] : '',
      }];
    });
  }

  /** Writes the exact file (the edit flow's save). */
  async save(path: string, content: string): Promise<{ ok: boolean; error?: string }> {
    const response = await this.events.publish({
      requestKnowledgeSave: { path, content },
    });
    return response.ok
      ? { ok: true }
      : { ok: false, error: response.rejectionMessage ?? `note '${path}' could not be saved` };
  }

  /** Creates a note from parts (the agent's flow; unique slug server-side). */
  async create(title: string, tags: string[], content: string): Promise<{ ok: boolean; error?: string }> {
    const response = await this.events.publish({
      requestKnowledgeSave: { title, tags, content },
    });
    return response.ok
      ? { ok: true }
      : { ok: false, error: response.rejectionMessage ?? 'the note could not be saved' };
  }

  /** Deletes one note; destructive, confirm before calling. */
  async delete(path: string): Promise<{ ok: boolean; error?: string }> {
    const response = await this.events.publish({
      requestKnowledgeDelete: { path },
    });
    return response.ok
      ? { ok: true }
      : { ok: false, error: response.rejectionMessage ?? `note '${path}' could not be deleted` };
  }

  private fold(event: DomainEventJson): void {
    switch (domainEventKind(event)) {
      case 'knowledgeSaved': {
        const entry = event.knowledgeSaved?.entry;
        if (!entry?.path || !this.loaded) break;
        this.index.update((entries) => {
          const next = entries.some((existing) => existing.path === entry.path)
            ? entries.map((existing) => (existing.path === entry.path ? entry : existing))
            : [...entries, entry];
          return [...next].sort((a, b) => a.path.localeCompare(b.path));
        });
        break;
      }
      case 'knowledgeDeleted': {
        const path = event.knowledgeDeleted?.path;
        if (!path || !this.loaded) break;
        this.index.update((entries) => entries.filter((entry) => entry.path !== path));
        if (this.selected() === path) this.selected.set(null);
        break;
      }
    }
  }
}

function sanitize(entries: unknown[]): KnowledgeEntryInfoJson[] {
  const result: KnowledgeEntryInfoJson[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const note = entry as Record<string, unknown>;
    if (typeof note['path'] !== 'string' || note['path'] === '') continue;
    result.push({
      path: note['path'],
      title: typeof note['title'] === 'string' && note['title'] !== '' ? note['title'] : note['path'],
      tags: Array.isArray(note['tags']) ? note['tags'].filter((t): t is string => typeof t === 'string') : [],
      size: typeof note['size'] === 'number' ? note['size'] : 0,
      updatedAt: typeof note['updatedAt'] === 'string' ? note['updatedAt'] : '',
    });
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
