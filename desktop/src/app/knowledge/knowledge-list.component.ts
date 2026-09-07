import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { KnowledgeService } from './knowledge.service';

/**
 * The knowledge list (Phase 9 S30): the assistant sidebar's second tab —
 * a search field over the library and the note list. Selection is shared
 * state on the service; the pane renders it.
 */
@Component({
  selector: 'app-knowledge-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './knowledge-list.component.html',
  styleUrl: './knowledge-list.component.scss',
})
export class KnowledgeListComponent {
  private readonly knowledge = inject(KnowledgeService);

  protected readonly query = signal('');
  protected readonly searching = signal(false);
  protected readonly entries = this.knowledge.entries;
  protected readonly selected = this.knowledge.selected;
  protected readonly loading = this.knowledge.loading;
  protected readonly error = this.knowledge.error;
  protected readonly dirty = this.knowledge.editingDirty;

  /** Server-scored results while a query is present; the full list otherwise. */
  protected readonly visible = signal<readonly { path: string; title: string }[]>([]);

  protected readonly placeholder = computed(() =>
    this.entries().length === 0 ? 'no notes yet' : 'search notes…',
  );

  constructor() {
    void this.knowledge.open();
  }

  protected async onSearchInput(value: string): Promise<void> {
    this.query.set(value);
    if (value.trim() === '') {
      this.visible.set([]);
      return;
    }
    this.searching.set(true);
    const results = await this.knowledge.search(value);
    if (this.query().trim() !== value.trim()) return; // A newer query superseded this one.
    this.searching.set(false);
    this.visible.set(results.map((result) => ({ path: result.path, title: result.title })));
  }

  protected select(path: string): void {
    void this.knowledge.select(path);
  }

  protected create(): void {
    void this.knowledge.beginCreate();
  }
}
