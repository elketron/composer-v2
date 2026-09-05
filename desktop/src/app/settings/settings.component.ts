import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { SettingsService } from './settings.service';

/**
 * Settings view: the model the runtime loads for planner and coder turns
 * (empty = opencode's own default). The provider endpoint stays in
 * opencode's config — composer only overrides the model.
 */
@Component({
  selector: 'app-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent {
  private readonly settings = inject(SettingsService);

  protected readonly model = this.settings.model;
  protected readonly loading = this.settings.loading;
  protected readonly saving = this.settings.saving;
  protected readonly error = this.settings.error;
  protected readonly saved = this.settings.saved;

  protected setModel(value: string): void {
    this.settings.setDraft(value);
  }

  protected save(): void {
    void this.settings.save();
  }

  protected reload(): void {
    void this.settings.load();
  }
}
