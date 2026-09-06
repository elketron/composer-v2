import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { marked } from 'marked';

import { PlanService } from './plan.service';

/**
 * The right pane of the Plan view: the planner's plan document, replaced
 * wholesale by planDocumentUpdated events. Read-only — the document is the
 * planner's, edited by its edit_document tool, not by the user.
 *
 * Rendered as markdown. Raw HTML is escaped first (tags display literally,
 * nothing executes), then Angular's default innerHTML sanitization guards
 * the generated markup (e.g. javascript: hrefs) — no sanitizer bypass.
 */
@Component({
  selector: 'app-plan-document',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './plan-document.component.html',
  styleUrl: './plan-document.component.scss',
})
export class PlanDocumentComponent {
  private readonly plan = inject(PlanService);

  protected readonly document = this.plan.planDocument;
  protected readonly isDone = this.plan.isDone;
  protected readonly session = this.plan.session;

  protected readonly rendered = computed<string | null>(() => {
    const text = this.document();
    if (!text) return null;
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    return marked.parse(escaped, { async: false });
  });
}
