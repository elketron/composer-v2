import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

import { renderMarkdown } from '../core/markdown';
import { MermaidDirective } from '../core/mermaid/mermaid.directive';
import { DocEditorComponent } from '../docs/doc-editor.component';
import { ConfirmService } from '../core/confirm/confirm.service';
import { KnowledgeService } from './knowledge.service';

/** The starter body a brand-new note opens with. */
const CREATE_STARTER = '';

/**
 * The knowledge pane (Phase 9 S30): renders the selected note, and edits
 * it — structured title/tags over a body editor — or creates a new one.
 * Writes rebuild the frontmatter and land through the knowledge commands;
 * unsaved work confirms via the service (tab switches and the route
 * guard share it). Notes are markdown: diagrams render like everywhere.
 */
@Component({
  selector: 'app-knowledge-pane',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MermaidDirective, DocEditorComponent],
  templateUrl: './knowledge-pane.component.html',
  styleUrl: './knowledge-pane.component.scss',
})
export class KnowledgePaneComponent {
  private readonly knowledge = inject(KnowledgeService);
  private readonly confirm = inject(ConfirmService);
  private readonly sanitizer = inject(DomSanitizer);

  protected readonly mode = this.knowledge.mode;
  protected readonly selectedPath = this.knowledge.selected;

  protected readonly title = signal('');
  protected readonly tags = signal('');
  protected readonly draft = signal<string | null>(null);
  protected readonly editOriginal = signal('');
  protected readonly saveError = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected readonly rendered = signal<string | null>(null);
  protected readonly content = signal<SafeHtml | null>(null);
  protected readonly readError = signal<string | null>(null);
  protected readonly savedNote = signal<string | null>(null);

  protected readonly dirty = computed(() => {
    if (this.mode() === 'edit') {
      return this.title().trim() !== this.editOriginal().trim() ||
        this.tags().trim() !== this.editTagsOriginal().trim() ||
        (this.draft() !== null && this.draft() !== this.editBody);
    }
    if (this.mode() === 'create') {
      return this.title().trim() !== '' || this.tags().trim() !== '' || this.draft() !== null && this.draft() !== CREATE_STARTER;
    }
    return false;
  });

  protected readonly saveDisabled = computed(() => {
    if (this.busy()) return true;
    if (this.mode() === 'create') return this.title().trim() === '';
    return false;
  });

  constructor() {
    // Load a selected note's file; reset when the selection or mode clears.
    effect(() => {
      const path = this.knowledge.selected();
      if (this.knowledge.mode() === 'view' && path !== null) {
        void this.load(path);
      }
      if (path === null && this.knowledge.mode() === 'view') {
        this.rendered.set(null);
        this.content.set(null);
        this.readError.set(null);
      }
    });
    // Mirror the dirty state for the tab switch + route guard.
    effect(() => {
      this.knowledge.editingDirty.set(this.dirty());
    });
  }

  protected async beginEdit(): Promise<void> {
    const path = this.selectedPath();
    if (!path) return;
    const result = await this.knowledge.read(path);
    if (!result.ok) {
      this.readError.set(result.error);
      return;
    }
    this.saveError.set(null);
    this.title.set(result.title);
    this.tags.set(result.tags.join(', '));
    this.editOriginal.set(result.title);
    this.editTagsOriginal.set(result.tags.join(', '));
    this.editBody = result.body;
    this.draft.set(null);
    this.knowledge.mode.set('edit');
  }

  protected async save(): Promise<void> {
    if (this.saveDisabled()) return;
    const mode = this.mode();
    this.busy.set(true);
    this.saveError.set(null);
    try {
      if (mode === 'edit') await this.saveEdit();
      else if (mode === 'create') await this.saveCreate();
    } finally {
      this.busy.set(false);
    }
  }

  protected async cancel(): Promise<void> {
    if (!(await this.knowledge.confirmDiscard())) return;
    this.knowledge.editingDirty.set(false);
    this.knowledge.mode.set('view');
    if (this.mode() === 'view' && this.selectedPath() === null) {
      // A cancelled create leaves nothing selected.
      this.rendered.set(null);
      this.content.set(null);
    }
  }

  protected async deleteSelected(): Promise<void> {
    const path = this.selectedPath();
    if (!path || this.busy()) return;
    const confirmed = await this.confirm.confirm({
      title: `Delete ${path}?`,
      detail: 'the note is removed from the knowledge library on disk',
      confirmLabel: 'delete',
      danger: true,
    });
    if (!confirmed) return;
    this.busy.set(true);
    try {
      const result = await this.knowledge.delete(path);
      if (!result.ok) {
        this.readError.set(result.error ?? 'the note could not be deleted');
        return;
      }
      // The fold clears the selection too; do it here so the pane resets
      // even when the library list was never loaded in this session.
      this.knowledge.selected.set(null);
      this.knowledge.mode.set('view');
    } finally {
      this.busy.set(false);
    }
  }

  private async saveEdit(): Promise<void> {
    const path = this.selectedPath();
    if (!path) return;
    const result = await this.knowledge.save(path, this.serialize());
    if (!result.ok) {
      this.saveError.set(result.error ?? 'the note could not be saved');
      return;
    }
    this.showResult(path, this.body());
    this.knowledge.editingDirty.set(false);
    this.knowledge.mode.set('view');
  }

  private async saveCreate(): Promise<void> {
    const result = await this.knowledge.create(
      this.title().trim(),
      this.parseTags(),
      this.body(),
    );
    if (!result.ok) {
      this.saveError.set(result.error ?? 'the note could not be saved');
      return;
    }
    this.knowledge.editingDirty.set(false);
    this.knowledge.mode.set('view');
    // The savedPath lands in the knowledgeSaved event; the fold adds the
    // entry — select the newest one by title match when it arrives.
    this.savedNote.set(this.title().trim());
    void this.selectSavedNote();
  }

  private async selectSavedNote(): Promise<void> {
    const title = this.savedNote();
    if (!title) return;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const entry = this.knowledge
        .entries()
        .find((note) => note.title.toLowerCase() === title.toLowerCase());
      if (entry && entry.path === this.selectedPath()) return;
      if (entry) {
        this.knowledge.selected.set(entry.path);
        this.savedNote.set(null);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    this.savedNote.set(null);
  }

  /** The file text a save writes: frontmatter rebuilt, body as edited. */
  private serialize(): string {
    const title = this.title().trim().replace(/\s+/g, ' ');
    const tags = this.parseTags();
    const frontmatter =
      `---\ntitle: ${title}\n` + (tags.length > 0 ? `tags: ${tags.join(', ')}\n` : '') + `---\n\n`;
    return `${frontmatter}${this.body()}`;
  }

  private body(): string {
    return (this.draft() ?? this.editBody).replace(/\s+$/, '') + '\n';
  }

  private parseTags(): string[] {
    return this.tags()
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '');
  }

  private async load(path: string): Promise<void> {
    this.readError.set(null);
    this.content.set(null);
    const result = await this.knowledge.read(path);
    if (this.knowledge.selected() !== path || this.knowledge.mode() !== 'view') return;
    if (!result.ok) {
      this.readError.set(result.error);
      return;
    }
    this.showResult(path, result.body);
  }

  /** Renders body markdown (frontmatter is structured, not rendered). */
  private showResult(path: string, body: string): void {
    this.readError.set(null);
    const html = renderMarkdown(body);
    this.rendered.set(html);
    this.content.set(this.sanitizer.bypassSecurityTrustHtml(html));
  }

  private editBody = '';
  private readonly editTagsOriginal = signal('');

  protected get editBodyBaseline(): string {
    return this.editBody;
  }
}
