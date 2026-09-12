import { ChangeDetectionStrategy, Component, inject, signal, viewChild, ElementRef } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { composerEnter, resizeComposer } from '../core/composer';

import { PlanService } from './plan.service';
import {
  ChatMessage,
  PlanningToolEntry,
  type PlanningTurnActivity,
} from '../core/models/plan.models';
import { assistantToolLabel, turnActivityLabel } from '../core/models/assistant.models';

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
  private readonly opened = signal<ReadonlySet<number>>(new Set());

  protected activityFor(message: ChatMessage): PlanningTurnActivity[] {
    return this.plan.session()?.turnActivityFor(message) ?? [];
  }

  protected isLive(message: ChatMessage): boolean {
    if (!this.sending()) return false;
    const users = this.messages().filter((entry) => entry.isUser);
    return users.at(-1)?.index === message.index;
  }

  protected isExpanded(message: ChatMessage): boolean {
    return this.isLive(message) || this.opened().has(message.index);
  }

  protected toggleActivity(message: ChatMessage): void {
    this.opened.update((current) => {
      const next = new Set(current);
      if (next.has(message.index)) next.delete(message.index);
      else next.add(message.index);
      return next;
    });
  }

  // The shared model-level label helpers (assistant's richer activity
  // ladder and the tool-name digest; the entry types line up structurally).
  protected readonly activityLabel = turnActivityLabel;
  protected readonly toolLabel = assistantToolLabel;

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
    resizeComposer(area);
  }

  protected keydown(event: KeyboardEvent): void {
    if (composerEnter(event)) this.send();
  }
}
