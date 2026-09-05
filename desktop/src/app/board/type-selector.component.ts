import { ChangeDetectionStrategy, Component, model } from '@angular/core';
import { LucideAngularModule, LucideIconData } from 'lucide-angular';

import { BoardFilter, CARD_TYPE_META, CARD_TYPES } from '../core/models/board.models';

interface FilterOption {
  readonly value: BoardFilter;
  readonly label: string;
  readonly icon?: LucideIconData;
  readonly accentVar?: string;
}

/** Board type selector (design.md §3.1): All · Coding · Design · Docs. */
@Component({
  selector: 'app-type-selector',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule],
  templateUrl: './type-selector.component.html',
  styleUrl: './type-selector.component.scss',
})
export class TypeSelectorComponent {
  readonly selected = model.required<BoardFilter>();

  protected readonly options: readonly FilterOption[] = [
    { value: 'all', label: 'all' },
    ...CARD_TYPES.map((type) => ({
      value: type as BoardFilter,
      label: CARD_TYPE_META[type].label,
      icon: CARD_TYPE_META[type].icon,
      accentVar: CARD_TYPE_META[type].accentVar,
    })),
  ];
}
