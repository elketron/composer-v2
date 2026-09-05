import { ChangeDetectionStrategy, Component, inject, signal, viewChild, ElementRef } from '@angular/core';
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

  private readonly composerArea = viewChild<ElementRef<HTMLTextAreaElement>>('composer');

  protected readonly messages = this.plan.messages;
  protected readonly streamingMessage = this.plan.streamingMessage;
  protected readonly sending = this.plan.isSending;
  protected readonly isDone = this.plan.isDone;
  // A signal so clearing it after send repaints under zoneless CD.
  protected readonly draft = signal('');

  protected send(): void {
    const text = this.draft();
    void this.plan.sendMessage(text).then((sent) => {
      if (sent) {
        this.draft.set('');
        const area = this.composerArea()?.nativeElement;
        if (area) area.style.height = 'auto';
      }
    });
  }

  protected newSession(): void {
    this.plan.requestNewSession();
  }

  /** Grows the composer with its content (up to the CSS cap). */
  protected resize(area: HTMLTextAreaElement): void {
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight, 180)}px`;
  }

  protected keydown(event: KeyboardEvent): void {
    // Enter sends; shift+enter (and alt/ctrl+enter) keep editing.
    if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    event.preventDefault();
    this.send();
  }
}
