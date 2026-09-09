import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';

import { renderMarkdown } from '../core/markdown';
import { CARD_TYPE_META, type CardType } from '../core/models/board.models';
import { parsePlanDocument, type PlanSegment } from '../core/models/plan.models';
import { PlanService } from './plan.service';

/**
 * The right pane of the Plan view: the planner's markdown plan document,
 * replaced wholesale by planDocumentUpdated events. The document is prose
 * plus embedded ticket blocks (`# Title` + YAML frontmatter); tickets render
 * as cards with their type and dependencies, the rest as markdown.
 * Read-only — the document is the planner's, edited by its edit_document
 * tool, not by the user.
 */
@Component({
  selector: 'app-plan-document',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule],
  templateUrl: './plan-document.component.html',
  styleUrl: './plan-document.component.scss',
})
export class PlanDocumentComponent {
  private readonly plan = inject(PlanService);

  protected readonly document = this.plan.planDocument;
  protected readonly isDone = this.plan.isDone;
  protected readonly session = this.plan.session;

  protected readonly segments = computed<PlanSegment[]>(() => parsePlanDocument(this.document()));

  protected markdown(text: string): string {
    return renderMarkdown(text);
  }

  protected meta(type: string): (typeof CARD_TYPE_META)[CardType] {
    return CARD_TYPE_META[type as CardType];
  }
}