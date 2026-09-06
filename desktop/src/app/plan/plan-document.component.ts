import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { renderMarkdown } from '../core/markdown';
import { PlanService } from './plan.service';

/**
 * The right pane of the Plan view: the planner's plan document, replaced
 * wholesale by planDocumentUpdated events. Read-only — the document is the
 * planner's, edited by its edit_document tool, not by the user.
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
    return text ? renderMarkdown(text) : null;
  });
}
