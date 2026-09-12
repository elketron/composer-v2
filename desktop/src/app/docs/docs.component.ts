import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
} from '@angular/core';
import { BookOpen, FilePlus, FolderPlus, LucideAngularModule, Pencil, Trash2 } from 'lucide-angular';

import { ShellService } from '../shell/shell.service';
import { routedProjectId } from '../shell/route-project-id';
import { MermaidDirective } from '../core/mermaid/mermaid.directive';
import { ConfirmService } from '../core/confirm/confirm.service';
import { FlowEditorComponent } from './flow/flow-editor.component';
import { DocEditorComponent } from './doc-editor.component';
import { DocsService } from './docs.service';
import { DocEditSession } from '../core/models/docs.models';

/** The starter text a new doc opens with. */
const CREATE_STARTER = '\n';

/**
 * Docs view (Phase 9): the project's markdown files under `docs/` — read,
 * and since S27 created, edited, renamed, and deleted. Files are the
 * truth; every mutation rides the validated processor and lands back as
 * metadata events. The viewer state machine lives in `DocsService` (the
 * selection, its fetch, and its renders), the editor's state machine on
 * `DocEditSession`, and the markdown rendering on `Doc`-level helpers —
 * this component renders and forwards intents.
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

  protected readonly icons = { docs: BookOpen, link: FolderPlus, newDoc: FilePlus, edit: Pencil, delete: Trash2 };

  // This instance always serves one project (the tab reuse strategy keys
  // instances by project) — a stable id, not the active tab's.
  protected readonly projectId = computed(() => this.myProjectId || this.shell.activeTabId());
  private readonly myProjectId = routedProjectId();
  protected readonly directory = computed(() => this.shell.activeTab()?.directory ?? null);
  protected readonly entries = computed(() =>
    [...this.docs.docs(this.projectId() ?? '')].sort((a, b) => a.path.localeCompare(b.path)),
  );

  // The read pane reads the service's viewer state (pass-throughs).
  protected readonly selected = computed(() => this.docs.viewer().path);
  protected readonly rendered = computed(() => this.docs.viewer().html);
  protected readonly content = computed(() => this.docs.viewer().content);
  protected readonly readError = computed(() => this.docs.viewer().error);

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

  private openedFor: string | null = null;

  constructor() {
    // The index refreshes on view entry; the editor and reader reset with
    // it. This instance serves one project (the tab reuse strategy keys
    // instances by project; it detaches — not dies — while another tab is
    // on screen), so the open is keyed on the resolved project: a tab
    // switch re-runs this effect for a detached view but never re-opens.
    effect(() => {
      const projectId = this.projectId();
      if (!projectId || projectId === this.openedFor) return;
      this.openedFor = projectId;
      this.session.reset();
      this.docs.clear();
      void this.docs.open(projectId);
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

  protected selectPath(path: string): void {
    const projectId = this.projectId();
    if (!projectId || path === this.selected()) return;
    void (async () => {
      if (!(await this.confirmDiscard())) return;
      this.session.reset();
      this.docs.select(projectId, path);
    })();
  }

  // ---- Modes ----

  protected beginEdit(): void {
    // The viewer carries the file's raw markdown — the editor begins from
    // it (no refetch; the viewer fetched exactly this file).
    const viewer = this.docs.viewer();
    if (viewer.path === null || viewer.text === null) return;
    this.session.beginEdit(viewer.text);
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
    this.session.reset();
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
    this.docs.show(path, text);
    this.session.reset();
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
    this.session.reset();
    this.docs.select(projectId, path);
  }

  private async saveRename(projectId: string): Promise<void> {
    const from = this.selected();
    const to = this.session.pathField().trim();
    if (!from || from === to) {
      this.session.reset();
      return;
    }
    const result = await this.docs.rename(projectId, from, to);
    if (!result.ok) {
      this.session.saveError.set(result.error ?? 'the doc could not be renamed');
      return;
    }
    this.session.reset();
    this.docs.select(projectId, to);
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
      if (result.ok) {
        this.session.reset();
        this.docs.clear();
      }
    } finally {
      this.session.busy.set(false);
    }
  }

  protected async linkDirectory(): Promise<void> {
    const projectId = this.projectId();
    if (!projectId) return;
    await this.shell.linkDirectory(projectId);
  }
}
