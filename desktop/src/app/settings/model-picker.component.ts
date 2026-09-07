import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';

let nextPickerId = 1;

@Component({
  selector: 'app-model-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './model-picker.component.html',
  styleUrl: './model-picker.component.scss',
})
export class ModelPickerComponent {
  readonly value = input('');
  readonly models = input<readonly string[]>([]);
  readonly placeholder = input('opencode default');
  readonly disabled = input(false);
  readonly valueChange = output<string>();

  protected readonly listId = `model-picker-${nextPickerId++}`;
  protected readonly open = signal(false);
  protected readonly activeIndex = signal(0);
  protected readonly filteredModels = computed(() => {
    const query = this.value().trim().toLowerCase();
    if (query === '') return [];
    return this.models()
      .filter((model) => model.toLowerCase().includes(query))
      .slice(0, 50);
  });

  protected update(value: string): void {
    this.valueChange.emit(value);
    this.activeIndex.set(0);
    this.open.set(value.trim() !== '');
  }

  protected onKeydown(event: KeyboardEvent): void {
    const results = this.filteredModels();
    if (event.key === 'Escape') {
      this.open.set(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (results.length === 0) return;
      event.preventDefault();
      this.open.set(true);
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      this.activeIndex.update((index) => (index + delta + results.length) % results.length);
      return;
    }
    if (event.key === 'Enter' && this.open() && results.length > 0) {
      event.preventDefault();
      this.choose(results[this.activeIndex()] ?? results[0]!);
    }
  }

  protected choose(model: string): void {
    this.valueChange.emit(model);
    this.open.set(false);
  }
}
