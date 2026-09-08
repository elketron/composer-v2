import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { BookOpen, FilePlus, FolderPlus, LucideAngularModule, Pencil, Trash2 } from 'lucide-angular';

import { ShellService } from '../shell/shell.service';
import { renderMarkdown } from '../core/markdown';
import { MermaidDirective } from '../core/mermaid/mermaid.directive';
import { ConfirmService } from '../core/confirm/confirm.service';
import { FlowEditorComponent } from './flow/flow-editor.component';
import { DocInfoJson } from '../core/events/wire';
import { DocEditorComponent } from './doc-editor.component';
import { DocsService } from './docs.service';
import { Doc, DocEditSession } from '../core/models/docs.models';

/** The starter text a new doc opens with. */
const CREATE_STARTER = '\n';

/**
 * Docs view (Phase 9): the project's markdown files under `docs/` — read,
 * and since S27 created, edited, renamed, and deleted. Files are the
 * truth; every mutation rides the validated processor and lands back as
 * metadata events. The editor's state machine lives on `DocEditSession`
 * and the markdown rendering on `Doc`; this component renders and forwards.
 */
@Component({
  selector: 'app-docs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, DocEditorComponent, FlowEditorComponent, MermaidDirective],
  templateUrl: './docs.component.html',
  styleUrl: './docs.component.scss',
})
export class DocsComponent {
  private readonly shell = inject(ShellService);
  private readonly docs = inject(DocsService);
  private readonly confirm = inject(ConfirmService);
  private readonly sanitizer = inject(DomSanitizer);

  protected readonly icons = { docs: BookOpen, link: FolderPlus, newDoc: FilePlus, edit: Pencil, delete: Trash2 };

  protected readonly projectId = computed(() => this.shell.activeTabId());
  protected readonly directory = computed(() => this.shell.activeTab()?.directory ?? null);
  protected readonly entries = computed(() =>
    [...this.docs.docs(this.projectId() ?? '')].sort((a, b) => a.path.localeCompare(b.path)),
  );

  protected readonly selected = signal<string | null>(null);
  /** The rendered markdown HTML (pre-bypass); `content` is its safe form. */
  protected readonly rendered = signal<string | null>(null);
  protected readonly content = signal<SafeHtml | null>(null);
  protected readonly readError = signal<string | null>(null);

  /** The editor's working copy (mode, draft, path field, edit surface). */
  readonly session = new DocEditSession(CREATE_STARTER);

  /** The text a brand-new doc opens with. */
  protected readonly starterText = CREATE_STARTER;

  protected readonly loading = this.docs.loading;
  protected readonly indexError = this.docs.error;

  /** Whether the current mode holds unsaved work. */
  protected readonly dirty = computed(() => this.session.dirty(this.selected()));

  protected readonly saveDisabled = computed(() => this.session.saveDisabled());

  /** Whether the doc being edited carries a mermaid fence for the canvas. */
  protected readonly hasFence = computed(() => this.session.hasFence());

  protected readonly fenceCode = computed(() => this.session.fenceCode());

  /** Swaps the edit surface; flow mode plants a starter fence if needed. */
  protected setEditorView(view: 'code' | 'flow'): void {
    this.session.setEditorView(view);
  }

  /** The flow canvas's fence edit lands back in the draft. */
  protected applyFence(code: string): void {
    this.session.applyFence(code);
  }

  constructor() {
    // Each project entry refreshes the index from disk (files are the
    // truth) and drops any open editor with it.
    effect(() => {
      const projectId = this.projectId();
      this.resetEditor();
      this.selected.set(null);
      this.rendered.set(null);
      this.content.set(null);
      this.readError.set(null);
      if (projectId) void this.docs.open(projectId);
    });
  }

  /**
   * The route guard's hook: leaving with unsaved work asks first. Also
   * used by in-view navigation that would discard the editor.
   */
  protected async confirmDiscard(): Promise<boolean> {
    if (!this.dirty()) return true;
    return await this.confirm.confirm({
      title: 'Discard unsaved changes?',
      detail: 'the document has edits that were not saved yet',
      confirmLabel: 'discard',
      danger: true,
    });
  }

  protected async select(entry: DocInfoJson): Promise<void> {
    const projectId = this.projectId();
    if (!projectId || entry.path === this.selected()) return;
    if (!(await this.confirmDiscard())) return;
    this.resetEditor();
    this.selected.set(entry.path);
    this.readError.set(null);
    this.content.set(null);
    const result = await this.docs.read(projectId, entry.path);
    if (this.selected() !== entry.path || this.session.mode() !== 'view') return;
    if (result.ok) {
      this.showDoc(Doc.fromWire(entry, result.content));
    } else {
      this.readError.set(result.error);
    }
  }

  // ---- Modes ----

  protected async beginEdit(): Promise<void> {
    const projectId = this.projectId();
    const path = this.selected();
    if (!projectId || !path) return;
    // The editor edits raw markdown, not the rendered HTML: refetch.
    const result = await this.docs.read(projectId, path);
    if (!result.ok) {
      this.readError.set(result.error);
      return;
    }
    this.session.beginEdit(result.content);
  }

  protected beginCreate(): void {
    this.session.beginCreate();
  }

  protected beginRename(): void {
    this.session.beginRename(this.selected());
  }

  /** Cancel: unsaved work confirms first. */
  protected async cancel(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    this.resetEditor();
  }

  /**
   * The route guard's hook: leaving the view with unsaved work asks
   * first. Public — the canDeactivate guard calls it.
   */
  async confirmLeave(): Promise<boolean> {
    return await this.confirmDiscard();
  }

  // ---- Mutations ----

  protected async save(): Promise<void> {
    const projectId = this.projectId();
    if (!projectId || this.saveDisabled()) return;
    this.session.busy.set(true);
    this.session.saveError.set(null);
    try {
      if (this.session.mode() === 'edit') {
        await this.saveEdit(projectId);
      } else if (this.session.mode() === 'create') {
        await this.saveCreate(projectId);
      } else if (this.session.mode() === 'rename') {
        await this.saveRename(projectId);
      }
    } finally {
      this.session.busy.set(false);
    }
  }

  private async saveEdit(projectId: string): Promise<void> {
    const path = this.selected();
    if (!path) return;
    const text = this.session.currentText();
    const result = await this.docs.save(projectId, path, text);
    if (!result.ok) {
      this.session.saveError.set(result.error ?? 'the doc could not be saved');
      return;
    }
    this.showText(path, text);
    this.resetEditor();
  }

  private async saveCreate(projectId: string): Promise<void> {
    const path = this.session.pathField().trim();
    if (this.entries().some((entry) => entry.path === path)) {
      const overwrite = await this.confirm.confirm({
        title: 'Overwrite this doc?',
        detail: `a doc with the path '${path}' already exists — saving replaces its content`,
        confirmLabel: 'overwrite',
        danger: true,
      });
      if (!overwrite) return;
    }
    const text = this.session.draft() ?? CREATE_STARTER;
    const result = await this.docs.save(projectId, path, text);
    if (!result.ok) {
      this.session.saveError.set(result.error ?? 'the doc could not be saved');
      return;
    }
    this.resetEditor();
    await this.selectPath(path);
  }

  private async saveRename(projectId: string): Promise<void> {
    const from = this.selected();
    const to = this.session.pathField().trim();
    if (!from || from === to) {
      this.resetEditor();
      return;
    }
    const result = await this.docs.rename(projectId, from, to);
    if (!result.ok) {
      this.session.saveError.set(result.error ?? 'the doc could not be renamed');
      return;
    }
    this.resetEditor();
    await this.selectPath(to);
  }

  protected async deleteSelected(): Promise<void> {
    const projectId = this.projectId();
    const path = this.selected();
    if (!projectId || !path || this.session.busy()) return;
    const confirmed = await this.confirm.confirm({
      title: `Delete ${path}?`,
      detail: 'the markdown file is removed from the project directory on disk',
      confirmLabel: 'delete',
      danger: true,
    });
    if (!confirmed) return;
    this.session.busy.set(true);
    try {
      const result = await this.docs.delete(projectId, path);
      if (!result.ok) {
        this.readError.set(result.error ?? 'the doc could not be deleted');
        return;
      }
      this.resetEditor();
      this.selected.set(null);
      this.rendered.set(null);
      this.content.set(null);
    } finally {
      this.session.busy.set(false);
    }
  }

  // ---- Helpers ----

  private showDoc(doc: Doc): void {
    this.readError.set(null);
    const html = doc.markup();
    this.rendered.set(html);
    this.content.set(this.sanitizer.bypassSecurityTrustHtml(html));
  }

  /** Shows saved text in the viewer without refetching (the file is it). */
  private showText(path: string, text: string): void {
    this.selected.set(path);
    this.readError.set(null);
    const html = renderMarkdown(text);
    this.rendered.set(html);
    this.content.set(this.sanitizer.bypassSecurityTrustHtml(html));
  }

  private async selectPath(path: string): Promise<void> {
    const projectId = this.projectId();
    if (!projectId) return;
    this.selected.set(path);
    this.content.set(null);
    this.readError.set(null);
    const result = await this.docs.read(projectId, path);
    if (this.selected() !== path) return;
    if (result.ok) {
      this.showText(path, result.content);
    } else {
      this.readError.set(result.error);
    }
  }

  private resetEditor(): void {
    this.session.reset();
  }

  protected async linkDirectory(): Promise<void> {
    const projectId = this.projectId();
    if (!projectId) return;
    await this.shell.linkDirectory(projectId);
  }
}