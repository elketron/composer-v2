import { Injectable, inject, signal } from '@angular/core';

import { EventsClient } from '../core/events/events-client';
import { DocInfoJson, DomainEventJson, domainEventKind } from '../core/events/wire';
import { RestClient } from '../core/rest';

/**
 * The docs index (Phase 9): markdown files under the project's docs/
 * directory. Files are the truth — `open()` fetches the list over REST on
 * view entry, and docSaved/docDeleted events keep the loaded project's
 * index live in between. Content is fetched per doc on demand.
 */
@Injectable({ providedIn: 'root' })
export class DocsService {
  private readonly events = inject(EventsClient);
  private readonly rest = inject(RestClient);

  /** Per-project indexes; only projects opened in this session are keyed. */
  private readonly index = signal<ReadonlyMap<string, readonly DocInfoJson[]>>(new Map());
  private readonly loaded = new Set<string>();

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    this.events.events$.subscribe((event) => this.fold(event));
  }

  /** The index of one project (empty before its first open). */
  docs(projectId: string): readonly DocInfoJson[] {
    return this.index().get(projectId) ?? [];
  }

  /** Whether the project's list came from the server (vs fold-only). */
  isOpen(projectId: string): boolean {
    return this.loaded.has(projectId);
  }

  /** Refreshes a project's index from disk (the REST read). */
  async open(projectId: string): Promise<void> {
    if (this.rest.serverBase === null) return;
    this.loading.set(true);
    try {
      const response = await this.rest.get<{ docs?: unknown; error?: unknown }>(
        `/projects/${encodeURIComponent(projectId)}/docs`,
      );
      if (response === null) {
        this.error.set('could not reach the server');
        return;
      }
      if (!response.ok || typeof response.body.error === 'string') {
        this.error.set(
          typeof response.body.error === 'string' ? response.body.error : `the docs of ${projectId} are unavailable`,
        );
        return;
      }
      const listed = response.body.docs;
      if (!Array.isArray(listed)) return;
      this.error.set(null);
      this.loaded.add(projectId);
      this.index.update((index) => new Map(index).set(projectId, sanitize(listed)));
    } finally {
      this.loading.set(false);
    }
  }

  /** One doc's markdown content, fetched on selection. */
  async read(
    projectId: string,
    path: string,
  ): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
    if (this.rest.serverBase === null) return { ok: false, error: 'no server attached' };
    const response = await this.rest.get<{ doc?: { content?: unknown }; error?: unknown }>(
      `/projects/${encodeURIComponent(projectId)}/docs/content?path=${encodeURIComponent(path)}`,
    );
    if (response === null) return { ok: false, error: 'could not reach the server' };
    if (!response.ok || typeof response.body.error === 'string') {
      return {
        ok: false,
        error: typeof response.body.error === 'string' ? response.body.error : `doc '${path}' is unavailable`,
      };
    }
    if (typeof response.body.doc?.content !== 'string') {
      return { ok: false, error: `doc '${path}' is unavailable` };
    }
    return { ok: true, content: response.body.doc.content };
  }

  /**
   * Creates or overwrites one doc through the validated processor; the
   * index updates via the docSaved fold (and the next REST refresh).
   */
  async save(projectId: string, path: string, content: string): Promise<{ ok: boolean; error?: string }> {
    const response = await this.events.publish({
      projectId,
      requestDocSave: { path, content },
    });
    return response.ok
      ? { ok: true }
      : { ok: false, error: response.rejectionMessage ?? `doc '${path}' could not be saved` };
  }

  /** Renames one doc (a server-side single rename; never overwrites). */
  async rename(projectId: string, path: string, to: string): Promise<{ ok: boolean; error?: string }> {
    const response = await this.events.publish({
      projectId,
      requestDocRename: { path, to },
    });
    return response.ok
      ? { ok: true }
      : { ok: false, error: response.rejectionMessage ?? `doc '${path}' could not be renamed` };
  }

  /** Deletes one doc from disk; destructive, confirm before calling. */
  async delete(projectId: string, path: string): Promise<{ ok: boolean; error?: string }> {
    const response = await this.events.publish({
      projectId,
      requestDocDelete: { path },
    });
    return response.ok
      ? { ok: true }
      : { ok: false, error: response.rejectionMessage ?? `doc '${path}' could not be deleted` };
  }

  private fold(event: DomainEventJson): void {
    switch (domainEventKind(event)) {
      case 'docSaved': {
        const doc = event.docSaved?.doc;
        if (!doc?.path || !this.loaded.has(event.projectId ?? '')) break;
        this.index.update((index) => {
          const docs = index.get(event.projectId!) ?? [];
          const next = docs.some((entry) => entry.path === doc.path)
            ? docs.map((entry) => (entry.path === doc.path ? doc : entry))
            : [...docs, doc];
          return new Map(index).set(event.projectId!, next);
        });
        break;
      }
      case 'docDeleted': {
        const path = event.docDeleted?.path;
        if (!path || !this.loaded.has(event.projectId ?? '')) break;
        this.index.update((index) => {
          const docs = index.get(event.projectId!) ?? [];
          return new Map(index).set(
            event.projectId!,
            docs.filter((entry) => entry.path !== path),
          );
        });
        break;
      }
    }
  }
}

function sanitize(docs: unknown[]): DocInfoJson[] {
  const seen = new Set<string>();
  const result: DocInfoJson[] = [];
  for (const entry of docs) {
    if (typeof entry !== 'object' || entry === null) continue;
    const doc = entry as Record<string, unknown>;
    const { path, title } = doc;
    if (typeof path !== 'string' || path === '' || seen.has(path)) continue;
    seen.add(path);
    result.push({
      path,
      title: typeof title === 'string' && title !== '' ? title : path,
      size: typeof doc['size'] === 'number' ? doc['size'] : 0,
      updatedAt: typeof doc['updatedAt'] === 'string' ? doc['updatedAt'] : '',
    });
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
