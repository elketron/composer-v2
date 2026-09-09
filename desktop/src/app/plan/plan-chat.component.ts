import { ChangeDetectionStrategy, Component, inject, signal, viewChild, ElementRef } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { PlanService } from './plan.service';
import { ChatMessage, PlanningToolEntry } from '../core/models/plan.models';

type PlanTurnActivity =
  | { readonly kind: 'message'; readonly id: string; readonly text: string }
  | { readonly kind: 'tool'; readonly id: string; readonly tool: PlanningToolEntry };

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

  protected activityFor(message: ChatMessage): PlanTurnActivity[] {
    const session = this.plan.session();
    if (!session) return [];
    const messages = session.messages
      .filter((entry) => entry.activity && entry.parentIndex === message.index)
      .sort((a, b) => a.index - b.index)
      .map((entry) => ({ kind: 'message' as const, id: `message-${entry.index}`, text: entry.text }));
    const tools = session.toolCalls
      .filter((entry) => entry.parentIndex === message.index)
      .map((tool) => ({ kind: 'tool' as const, id: `tool-${tool.toolCallId}`, tool }));
    return [...messages, ...tools];
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

  protected activityLabel(activity: readonly PlanTurnActivity[]): string {
    return `${activity.length} ${activity.length === 1 ? 'activity item' : 'activity items'}`;
  }

  protected toolLabel(entry: PlanningToolEntry): string {
    const name = entry.toolName.replace(/^composer_/, '');
    const first = entry.args && typeof entry.args === 'object'
      ? Object.values(entry.args as Record<string, unknown>).find((value) => typeof value === 'string')
      : undefined;
    return typeof first === 'string' && first !== '' ? `${name} · ${first}` : name;
  }

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
