import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { PlanService } from './plan.service';

@Component({
  selector: 'app-plan-chat',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  templateUrl: './plan-chat.component.html',
  styleUrl: './plan-chat.component.scss',
})
export class PlanChatComponent {
  private readonly plan = inject(PlanService);

  protected readonly messages = this.plan.messages;
  protected readonly streamingMessage = this.plan.streamingMessage;
  protected readonly sending = this.plan.isSending;
  protected readonly isDone = this.plan.isDone;
  // A signal so clearing it after send repaints under zoneless CD.
  protected readonly draft = signal('');

  protected send(): void {
    const text = this.draft();
    void this.plan.sendMessage(text).then((sent) => {
      if (sent) this.draft.set('');
    });
  }

  protected newSession(): void {
    this.plan.requestNewSession();
  }

  protected keydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    this.send();
  }
}
