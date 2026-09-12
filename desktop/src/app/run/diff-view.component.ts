import { ChangeDetectionStrategy, Component, HostListener, computed, effect, inject, input, signal } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { LucideAngularModule, ArrowLeft } from 'lucide-angular';
import { html as diffHtml, parse as diffParse } from 'diff2html';

import { trustHtml } from '../core/trusted-html';
import { PipelineService } from '../pipelines/pipeline.service';
import { ShellService } from '../shell/shell.service';

/**
 * The diff page: one changed file's working-tree diff, read-only —
 * reached from the run view's changed-files list
 * (`run/:cardId/diff?file=…`; esc or the back button returns to the
 * run). The patch is fetched fresh on every open (the working tree is
 * the truth); diff2html renders it (markup restyled in styles.scss).
 */
@Component({
  selector: 'app-diff-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule],
  templateUrl: './diff-view.component.html',
  styleUrl: './diff-view.component.scss',
})
export class DiffViewComponent {
  private readonly pipelines = inject(PipelineService);
  private readonly router = inject(Router);
  private readonly shell = inject(ShellService);
  private readonly sanitizer = inject(DomSanitizer);

  /** The route params (the file rides the query string: paths contain slashes). */
  readonly cardId = input.required<string>();
  readonly file = input<string>();

  /** The card's agent session (its session id fetches the diff). */
  private readonly session = computed(() => this.pipelines.sessionForCard(this.cardId()));

  /** The fetched patch: null while loading, '' when unavailable. */
  protected readonly patch = signal<string | null>(null);

  /** The rendered diff (diff2html markup, trusted). */
  protected readonly markup = computed<SafeHtml | null>(() => {
    const patch = this.patch();
    if (patch === null || patch === '') return null;
    try {
      return trustHtml(
        this.sanitizer,
        diffHtml(diffParse(patch), { outputFormat: 'line-by-line', drawFileList: false, matching: 'lines' }),
      );
    } catch {
      return null;
    }
  });

  constructor() {
    // Every file selection fetches its patch fresh; clearing the param
    // clears the view.
    effect(() => {
      const path = this.file();
      if (path === undefined) {
        this.patch.set(null);
        return;
      }
      void this.load(path);
    });
  }

  private async load(path: string): Promise<void> {
    this.patch.set(null);
    const session = this.session();
    const projectId = this.shell.activeTabId();
    if (session?.sessionId === undefined || projectId === null) {
      this.patch.set('');
      return;
    }
    const patch = await this.pipelines.diffFor(session.sessionId, path, projectId);
    // The view shows the picked file's patch only (a slower read for an
    // earlier selection must not land).
    if (this.file() !== path) return;
    this.patch.set(patch);
  }

  protected back(): void {
    const projectId = this.shell.activeTabId();
    if (projectId) void this.router.navigate(['/projects', projectId, 'coding', 'run', this.cardId()]);
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.file() !== undefined) this.back();
  }

  protected icons = { back: ArrowLeft };
}
