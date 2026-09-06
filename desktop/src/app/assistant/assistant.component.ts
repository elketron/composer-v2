import { ChangeDetectionStrategy, Component, computed, inject, signal, viewChild, ElementRef } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { renderMarkdown } from '../core/markdown';
import { ShellService } from '../shell/shell.service';
import { ConfirmService } from '../core/confirm/confirm.service';
import { AssistantService } from './assistant.service';

/**
 * The global assistant (Phase 6): a thread sidebar, the transcript with its
 * live composer, and the project scope picker beside the conversation.
 * Scope changes publish wholesale; archive asks for confirmation.
 */
@Component({
  selector: 'app-assistant',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  templateUrl: './assistant.component.html',
  styleUrl: './assistant.component.scss',
})
export class AssistantComponent {
  private readonly assistant = inject(AssistantService);
  private readonly shell = inject(ShellService);
  private readonly confirm = inject(ConfirmService);

  protected readonly threads = this.assistant.activeThreads;
  protected readonly archived = this.assistant.archivedThreads;
  protected readonly thread = this.assistant.thread;
  protected readonly messages = this.assistant.messages;
  protected readonly streamingMessage = this.assistant.streamingMessage;
  protected readonly sending = this.assistant.isSending;
  protected readonly error = this.assistant.error;

  protected readonly projects = this.shell.activeProjects;
  /** The active thread's scope as project names, for the header chips. */
  protected readonly scope = computed(() => {
    const ids = this.thread()?.projectIds ?? [];
    return ids.map((id) => ({
      id,
      name: this.shell.tabs().find((project) => project.id === id)?.name ?? id,
    }));
  });
  /**
   * Checkbox state for the scope picker. Null means "not yet drafted" and
   * falls back to the thread's scope, so the picker is correct even before
   * the details element's toggle event lands.
   */
  protected readonly scopeDraft = signal<ReadonlySet<string> | null>(null);

  // A signal so clearing it after send repaints under zoneless CD.
  protected readonly draft = signal('');
  protected readonly renaming = signal(false);
  protected readonly nameDraft = signal('');

  /** A retry is possible when the thread has a user message and is not running. */
  protected readonly canRetry = computed(() => {
    const thread = this.thread();
    return thread !== null && !thread.isRunning && thread.messages.some((message) => message.isUser);
  });

  private readonly composerArea = viewChild<ElementRef<HTMLTextAreaElement>>('composer');

  protected select(threadId: string): void {
    this.assistant.select(threadId);
  }

  protected newThread(): void {
    void this.assistant.createThread();
  }

  protected async archive(threadId: string): Promise<void> {
    const confirmed = await this.confirm.confirm({
      title: 'Archive this thread?',
      detail: 'Its transcript is kept and the thread can be restored.',
      confirmLabel: 'archive',
      danger: true,
    });
    if (!confirmed) return;
    const failure = await this.assistant.archiveThread(threadId);
    if (failure) this.error.set(failure);
  }

  protected restore(threadId: string): void {
    void this.assistant.restoreThread(threadId);
  }

  protected stop(): void {
    const thread = this.thread();
    if (thread) void this.assistant.stopThread(thread.id);
  }

  protected retry(): void {
    const thread = this.thread();
    if (thread) void this.assistant.retryThread(thread.id);
  }

  protected startRename(): void {
    const thread = this.thread();
    if (!thread) return;
    this.nameDraft.set(thread.name);
    this.renaming.set(true);
  }

  protected async saveRename(): Promise<void> {
    const thread = this.thread();
    if (!thread) return;
    const name = this.nameDraft().trim();
    this.renaming.set(false);
    if (name === '' || name === thread.name) return;
    await this.assistant.renameThread(thread.id, name);
  }

  /** Agent replies render as safe markdown; user messages stay plain text. */
  protected markdown(text: string): string {
    return renderMarkdown(text);
  }

  protected openScopePicker(): void {
    this.scopeDraft.set(new Set(this.thread()?.projectIds ?? []));
  }

  protected toggleScope(id: string, checked: boolean): void {
    this.scopeDraft.update((draft) => {
      const base = draft ?? new Set(this.thread()?.projectIds ?? []);
      const next = new Set(base);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  protected scopeChecked(id: string): boolean {
    const draft = this.scopeDraft();
    if (draft) return draft.has(id);
    return this.thread()?.projectIds.includes(id) ?? false;
  }

  protected async saveScope(): Promise<void> {
    const thread = this.thread();
    if (!thread) return;
    const draft = this.scopeDraft() ?? new Set(thread.projectIds);
    await this.assistant.setScope(thread.id, [...draft]);
  }

  protected send(): void {
    const text = this.draft();
    void this.assistant.sendMessage(text).then((sent) => {
      if (sent) {
        this.draft.set('');
        const area = this.composerArea()?.nativeElement;
        if (area) area.style.height = 'auto';
      }
    });
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
