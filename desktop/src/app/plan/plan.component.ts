import { ChangeDetectionStrategy, Component, effect, inject } from '@angular/core';

import { ShellService } from '../shell/shell.service';
import { PlanChatComponent } from './plan-chat.component';
import { PlanDocumentComponent } from './plan-document.component';
import { PlanService } from './plan.service';

@Component({
  selector: 'app-plan',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PlanChatComponent, PlanDocumentComponent],
  templateUrl: './plan.component.html',
  styleUrl: './plan.component.scss',
})
export class PlanComponent {
  private readonly plan = inject(PlanService);
  private readonly shell = inject(ShellService);

  protected readonly session = this.plan.session;
  protected readonly status = this.plan.status;

  protected newSession(): void {
    this.plan.requestNewSession();
  }

  constructor() {
    effect(() => this.plan.setProject(this.shell.activeTabId()));
  }
}
