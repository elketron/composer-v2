// The docs domain models (F2): a doc owns its own representation — the
// markdown rendering and the mermaid fence the flow editor edits — instead
// of the view rendering raw wire JSON. `DocEditSession` owns the docs
// editor's state machine (mode, draft, baseline, path field, edit surface),
// so the component only renders and forwards edits.

import { computed, signal } from '@angular/core';

import { renderMarkdown } from '../markdown';
import {
  appendMermaidFence,
  extractMermaidFence,
  replaceMermaidFence,
} from '../../docs/flow/flow-graph';
import type { DocInfoJson } from '../events/wire';

export class Doc {
  readonly path: string;
  readonly title: string;
  readonly size: number;
  readonly updatedAt: string;
  readonly content: string;

  constructor(data: { path: string; title: string; size: number; updatedAt: string; content: string }) {
    this.path = data.path;
    this.title = data.title;
    this.size = data.size;
    this.updatedAt = data.updatedAt;
    this.content = data.content;
  }

  static fromWire(info: DocInfoJson, content: string): Doc {
    return new Doc({ path: info.path, title: info.title, size: info.size, updatedAt: info.updatedAt, content });
  }

  /** The safe markdown HTML (raw HTML escaped; the sanitizer still guards). */
  markup(): string {
    return renderMarkdown(this.content);
  }

  /** The first mermaid fence's code, or null when the doc has none. */
  fenceCode(): string | null {
    return extractMermaidFence(this.content);
  }

  /** A starter fence added to a doc that has none yet. */
  withStarterFence(): string {
    return appendMermaidFence(this.content);
  }

  /** The fence's code replaced; the rest of the document is untouched. */
  withFence(code: string): string {
    return replaceMermaidFence(this.content, code);
  }
}

export type DocEditMode = 'view' | 'edit' | 'create' | 'rename';

/**
 * The docs editor's state machine: the mode, the edit surface, the draft
 * and its baseline, the path field, and the save lifecycle. The component
 * renders these signals and forwards edits; the session owns the rules
 * (dirty, save-enabled, the fence swaps over the live draft).
 */
export class DocEditSession {
  readonly mode = signal<DocEditMode>('view');
  /** The editor's live text (null until the first keystroke). */
  readonly draft = signal<string | null>(null);
  /** The content the edit session started from (the dirty baseline). */
  readonly editOriginal = signal<string | null>(null);
  /** The path field (create and rename modes). */
  readonly pathField = signal('');
  /** The edit surface: CodeMirror text or the flow canvas over the fence. */
  readonly editorView = signal<'code' | 'flow'>('code');
  readonly saveError = signal<string | null>(null);
  readonly busy = signal(false);

  readonly fenceCode = computed(() => extractMermaidFence(this.draft() ?? '') ?? '');

  constructor(private readonly starterText: string) {}

  beginEdit(content: string): void {
    this.saveError.set(null);
    this.editOriginal.set(content);
    this.draft.set(null);
    this.mode.set('edit');
  }

  beginCreate(): void {
    this.saveError.set(null);
    this.editOriginal.set(null);
    this.draft.set(null);
    this.pathField.set('');
    this.mode.set('create');
  }

  beginRename(selected: string | null): void {
    this.saveError.set(null);
    this.pathField.set(selected ?? '');
    this.mode.set('rename');
  }

  reset(): void {
    this.mode.set('view');
    this.editorView.set('code');
    this.draft.set(null);
    this.editOriginal.set(null);
    this.pathField.set('');
    this.saveError.set(null);
  }

  /** Whether the session holds unsaved work. */
  dirty(selected: string | null): boolean {
    switch (this.mode()) {
      case 'edit':
        return this.draft() !== null && this.draft() !== this.editOriginal();
      case 'create':
        return this.pathField().trim() !== '' || (this.draft() !== null && this.draft() !== this.starterText);
      case 'rename':
        return this.pathField() !== '' && this.pathField() !== selected;
      default:
        return false;
    }
  }

  saveDisabled(): boolean {
    if (this.busy()) return true;
    if (this.mode() === 'create' || this.mode() === 'rename') {
      return this.pathField().trim() === '';
    }
    return false;
  }

  hasFence(): boolean {
    return this.draft() !== null && extractMermaidFence(this.draft()!) !== null;
  }

  /** The doc text being edited: the typed draft, else the loaded baseline. */
  currentText(): string {
    if (this.mode() === 'create') return this.draft() ?? this.starterText;
    return this.draft() ?? this.editOriginal() ?? '';
  }

  /** Swaps the edit surface; flow mode plants a starter fence if needed. */
  setEditorView(view: 'code' | 'flow'): void {
    if (view === this.editorView()) return;
    if (view === 'flow' && !this.hasFence()) {
      this.draft.set(appendMermaidFence(this.currentText()));
    }
    this.editorView.set(view);
  }

  /** The flow canvas's fence edit lands back in the draft. */
  applyFence(code: string): void {
    this.draft.set(replaceMermaidFence(this.currentText(), code));
  }
}