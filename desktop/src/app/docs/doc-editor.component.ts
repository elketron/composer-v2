import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  inject,
  input,
  output,
} from '@angular/core';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, keymap } from '@codemirror/view';

/**
 * The docs editor (Phase 9 S27): a minimal CodeMirror 6 surface — markdown
 * language, history, line wrap, the app's monospace voice. The parent owns
 * the document lifecycle; this wrapper forwards edits and exposes the
 * current text. No eval: CodeMirror 6 runs clean under the renderer CSP.
 */
@Component({
  selector: 'app-doc-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
  styles: [
    `
      :host {
        display: block;
        min-height: 0;
        overflow: hidden;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--panel);
      }
    `,
  ],
})
export class DocEditorComponent {
  /** The document the editor opens with (set once per edit session). */
  readonly content = input.required<string>();

  /** Emits the full text on every document change. */
  readonly contentChange = output<string>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);
  private view: EditorView | null = null;

  constructor() {
    // One editor per edit session (the parent recreates this component per
    // session), created after the host element exists.
    afterNextRender(() => {
      const parent = document.createElement('div');
      parent.className = 'cm-host';
      parent.style.height = '100%';
      this.host.nativeElement.appendChild(parent);
      this.view = new EditorView({
        state: EditorState.create({ doc: this.content(), extensions: this.extensions() }),
        parent,
      });
    });
    this.destroyRef.onDestroy(() => {
      this.view?.destroy();
      this.view = null;
    });
  }

  /** The editor's current text (what a save persists). */
  value(): string {
    return this.view?.state.doc.toString() ?? this.content();
  }

  /** Focuses the editor (edit mode opens keyboard-ready). */
  focus(): void {
    this.view?.focus();
  }

  private extensions(): Extension[] {
    return [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      markdown(),
      syntaxHighlighting(defaultHighlightStyle),
      EditorView.lineWrapping,
      drawSelection(),
      EditorView.theme({
        '&': {
          height: '100%',
          fontSize: '13px',
          color: 'var(--text)',
          backgroundColor: 'transparent',
        },
        '&.cm-focused': { outline: 'none' },
        '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.55' },
        '.cm-content': { caretColor: 'var(--accent-soft)' },
        '.cm-cursor': { borderLeftColor: 'var(--accent-soft)' },
        '.cm-selectionBackground': {
          backgroundColor: 'color-mix(in srgb, var(--accent) 40%, transparent) !important',
        },
        '.cm-activeLine': {
          backgroundColor: 'color-mix(in srgb, var(--text) 4%, transparent)',
        },
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) this.contentChange.emit(update.state.doc.toString());
      }),
    ];
  }
}
