import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';

import { PlanService } from './plan.service';

/**
 * The right pane of the Plan view: the planner's plan document, replaced
 * wholesale by planDocumentUpdated events. Read-only — the document is the
 * planner's, edited by its edit_document tool, not by the user.
 *
 * Rendered as markdown; raw HTML (the plan's XML skeleton, any tags) is
 * escaped first so tags display literally and nothing executes.
 */
@Component({
  selector: 'app-plan-document',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './plan-document.component.html',
  styleUrl: './plan-document.component.scss',
})
export class PlanDocumentComponent {
  private readonly plan = inject(PlanService);
  private readonly sanitizer = inject(DomSanitizer);

  protected readonly document = this.plan.planDocument;
  protected readonly isDone = this.plan.isDone;
  protected readonly session = this.plan.session;

  protected readonly rendered = computed<SafeHtml | null>(() => {
    const text = this.document();
    if (!text) return null;
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    return this.sanitizer.bypassSecurityTrustHtml(marked.parse(escaped, { async: false }));
  });
}
