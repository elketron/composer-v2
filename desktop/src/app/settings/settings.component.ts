import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { SettingsService } from './settings.service';
import { ModelPickerComponent } from './model-picker.component';

/**
 * Settings view: the default model plus per-agent overrides (planner,
 * coder, and custom kinds added here). Empty = opencode's own default.
 * The provider endpoint stays in opencode's config — composer only
 * overrides models.
 */
@Component({
  selector: 'app-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ModelPickerComponent],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent {
  private readonly settings = inject(SettingsService);

  protected readonly model = this.settings.model;
  protected readonly models = this.settings.models;
  protected readonly agentKinds = this.settings.agentKinds;
  protected readonly availableModels = this.settings.availableModels;
  protected readonly loading = this.settings.loading;
  protected readonly saving = this.settings.saving;
  protected readonly error = this.settings.error;
  protected readonly saved = this.settings.saved;

  protected readonly newAgent = signal('');

  protected setModel(value: string): void {
    this.settings.setModel(value);
  }

  protected setAgentModel(kind: string, value: string): void {
    this.settings.setAgentModel(kind, value);
  }

  protected addAgent(): void {
    if (this.settings.addAgent(this.newAgent())) this.newAgent.set('');
  }

  protected save(): void {
    void this.settings.save();
  }

  protected reload(): void {
    void this.settings.load();
  }
}
