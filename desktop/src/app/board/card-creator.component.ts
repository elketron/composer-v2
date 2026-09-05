import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { CARD_TYPE_META, CARD_TYPES, CardType } from '../core/models/board.models';
import { BoardService } from './board.service';

/**
 * The new-card form (design.md §3): title, optional description, type —
 * the only way to author a card outside the planner. The server allocates
 * the id; the card lands via its echo and opens in the detail panel.
 */
@Component({
  selector: 'app-card-creator',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  templateUrl: './card-creator.component.html',
  styleUrl: './card-creator.component.scss',
})
export class CardCreatorComponent {
  private readonly board = inject(BoardService);

  readonly closed = output<void>();

  protected readonly typeOptions = CARD_TYPES;
  protected readonly typeMeta = CARD_TYPE_META;

  protected readonly title = signal('');
  protected readonly description = signal('');
  protected readonly type = signal<CardType>('coding');
  protected readonly error = signal<string | null>(null);
  protected readonly submitting = signal(false);

  protected submit(): void {
    if (this.submitting()) return;
    this.submitting.set(true);
    void this.board
      .createCard({
        title: this.title(),
        description: this.description(),
        type: this.type(),
      })
      .then((result) => {
        this.submitting.set(false);
        if (result.ok) this.closed.emit();
        else this.error.set(result.reason ?? 'the card was refused');
      });
  }

  protected cancel(): void {
    this.closed.emit();
  }
}
