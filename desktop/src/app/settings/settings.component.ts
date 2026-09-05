import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Settings view placeholder. The planner settings (model + provider base URL,
 * stored in the global DB) land in step 6 together with the planner agent.
 */
@Component({
  selector: 'app-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent {}
