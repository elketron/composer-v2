import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { Lock, MessageSquare } from 'lucide-angular';

import { AgePipe } from '../core/age.pipe';
import { Card } from '../core/models/board.models';

/**
 * Card anatomy (design.md §3.2): type icon + accent bar, id, tags, title,
 * two-line snippet, assignee + age, session link + file stats, dependency
 * lock chip, pulse indicator while an agent works the card. Click or Enter
 * opens the card in the detail panel.
 */
@Component({
  selector: 'app-board-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, AgePipe],
  templateUrl: './board-card.component.html',
  styleUrl: './board-card.component.scss',
  host: {
    tabindex: '0',
    role: 'button',
    '(click)': 'activate()',
    '(keydown.enter)': 'activate()',
  },
})
export class BoardCardComponent {
  readonly card = input.required<Card>();
  readonly blocked = input(false);

  /** The user asked to open this card in the detail panel. */
  readonly activated = output<Card>();

  protected readonly meta = computed(() => this.card().meta);
  protected readonly working = computed(() => this.card().isWorking());

  protected readonly hasStats = computed(() => {
    const stats = this.card().fileStats;
    return stats !== undefined && (stats.added > 0 || stats.removed > 0);
  });

  protected readonly lockTooltip = computed(
    () => `blocked by ${this.card().blockedBy.join(', ')}`,
  );

  protected readonly icons = { lock: Lock, session: MessageSquare };

  protected activate(): void {
    this.activated.emit(this.card());
  }
}
