import { Injectable, computed, inject, signal } from '@angular/core';

import { RestClient } from '../rest';

export interface ProjectDirectorySelection {
  readonly name: string;
  readonly directory: string;
}

export interface DirectoryEntry {
  readonly name: string;
  readonly path: string;
}

export interface DirectoryListing {
  readonly directory: string;
  readonly name: string;
  readonly parent: string | null;
  readonly directories: readonly DirectoryEntry[];
}

interface PickerRequest {
  resolve: (selection: ProjectDirectorySelection | null) => void;
}

/**
 * Global server-backed directory picker. All paths and directory reads come
 * from the attached server, not Electron's host OS filesystem.
 */
@Injectable({ providedIn: 'root' })
export class DirectoryPickerService {
  private readonly rest = inject(RestClient);
  private readonly pending = signal<PickerRequest | null>(null);
  private requestId = 0;
  private opener: HTMLElement | null = null;

  readonly current = this.pending.asReadonly();
  readonly path = signal('');
  readonly listing = signal<DirectoryListing | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly filteredDirectories = computed(() => {
    const directories = this.listing()?.directories ?? [];
    const value = this.path().trim();
    if (value === '' || value === this.listing()?.directory) return directories;
    const separator = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
    const filter = value.slice(separator + 1).toLocaleLowerCase();
    return filter === ''
      ? directories
      : directories.filter((directory) => directory.name.toLocaleLowerCase().includes(filter));
  });

  pick(initialDirectory?: string | null): Promise<ProjectDirectorySelection | null> {
    this.pending()?.resolve(null);
    this.opener =
      typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    this.path.set(initialDirectory?.trim() ?? '');
    this.listing.set(null);
    this.error.set(null);
    void this.browse(this.path());
    return new Promise((resolve) => this.pending.set({ resolve }));
  }

  async browse(path = this.path()): Promise<void> {
    const requestId = ++this.requestId;
    this.loading.set(true);
    this.error.set(null);
    const query = path.trim() ? `?path=${encodeURIComponent(path.trim())}` : '';
    const response = await this.rest.get<Partial<DirectoryListing> & { error?: string }>(
      `/directories${query}`,
    );
    try {
      if (response === null) throw new Error('backend unavailable');
      if (!response.ok) {
        throw new Error(response.body.error || `directory request failed (${response.status})`);
      }
      const body = response.body;
      if (
        typeof body.directory !== 'string' ||
        typeof body.name !== 'string' ||
        !Array.isArray(body.directories)
      ) {
        throw new Error('the server returned a malformed directory listing');
      }
      if (requestId !== this.requestId) return;
      const listing = body as DirectoryListing;
      this.listing.set(listing);
      this.path.set(listing.directory);
    } catch (error) {
      if (requestId === this.requestId) {
        this.error.set(error instanceof Error ? error.message : 'directory is unavailable');
      }
    } finally {
      if (requestId === this.requestId) this.loading.set(false);
    }
  }

  select(): void {
    const listing = this.listing();
    if (listing === null) return;
    this.resolve({ name: listing.name, directory: listing.directory });
  }

  cancel(): void {
    this.resolve(null);
  }

  private resolve(selection: ProjectDirectorySelection | null): void {
    const pending = this.pending();
    if (pending === null) return;
    this.pending.set(null);
    pending.resolve(selection);
    this.opener?.focus();
    this.opener = null;
  }
}
