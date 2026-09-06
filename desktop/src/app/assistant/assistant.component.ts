import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, viewChild, ElementRef } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { renderMarkdown } from '../core/markdown';
import { ShellService } from '../shell/shell.service';
import { ConfirmService } from '../core/confirm/confirm.service';
import {
  AssistantMessage,
  AssistantToolEntry,
  type ProposalCardType,
  type ProposalItem,
} from '../core/models/assistant.models';
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

  /** The thread's proposals (Phase 8) and the local edits on the draft. */
  protected readonly proposals = this.assistant.proposals;
  protected readonly draftProposal = this.assistant.draftProposal;
  protected readonly editItems = signal<ProposalItem[]>([]);
  private readonly lastDraftId = signal('');
  protected readonly confirmError = signal<string | null>(null);
  protected readonly confirming = signal(false);
  protected readonly lastConfirmed = computed(
    () => this.proposals().find((proposal) => proposal.status === 'CONFIRMED') ?? null,
  );
  protected readonly includedCount = computed(
    () => this.editItems().filter((item) => item.included).length,
  );
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
  /** The user message being edited in the composer (edit-and-resend). */
  protected readonly editing = signal<AssistantMessage | null>(null);

  /** Tool-activity boxes the user opened manually (past turns). */
  private readonly openedBoxes = signal<ReadonlySet<string>>(new Set());

  /** A retry is possible when the thread has a user message and is not running. */
  protected readonly canRetry = computed(() => {
    const thread = this.thread();
    return thread !== null && !thread.isRunning && thread.messages.some((message) => message.isUser);
  });

  private readonly composerArea = viewChild<ElementRef<HTMLTextAreaElement>>('composer');
  private readonly transcriptEl = viewChild<ElementRef<HTMLElement>>('transcript');

  /** Streaming stays pinned to the bottom unless the user scrolled up. */
  private readonly pinned = signal(true);

  constructor() {
    // Follow the stream: on any transcript change, snap to the bottom when
    // the user hasn't scrolled away. Tool activity rows also grow the pane.
    effect(() => {
      this.messages();
      this.streamingMessage();
      this.thread()?.toolCalls;
      if (!this.pinned()) return;
      const pane = this.transcriptEl()?.nativeElement;
      if (pane) pane.scrollTop = pane.scrollHeight;
    });
    // A fresh draft seeds the editable copies (edits ride the confirm).
    effect(() => {
      const draft = this.draftProposal();
      if (draft && draft.id !== this.lastDraftId()) {
        this.lastDraftId.set(draft.id);
        this.confirmError.set(null);
        this.editItems.set(draft.items.map((item) => ({ ...item })));
      } else if (!draft) {
        this.lastDraftId.set('');
      }
    });
  }

  protected onTranscriptScroll(): void {
    const pane = this.transcriptEl()?.nativeElement;
    if (!pane) return;
    const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 48;
    this.pinned.set(atBottom);
  }

  protected select(threadId: string): void {
    this.assistant.select(threadId);
    this.pinned.set(true);
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
    if (thread) {
      this.pinned.set(true);
      void this.assistant.retryThread(thread.id);
    }
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

  // ---- The working box (S25): a turn's tool activity ----

  /** The tool entries of the turn this user message opened. */
  protected activityFor(message: AssistantMessage): AssistantToolEntry[] {
    const thread = this.thread();
    if (!thread) return [];
    return thread.toolCallsFor(message.id);
  }

  /** A running turn whose reply hasn't landed: the box is open live. */
  protected isLive(message: AssistantMessage): boolean {
    const thread = this.thread();
    if (!thread || !thread.isRunning) return false;
    const path = this.messages();
    const at = path.findIndex((entry) => entry.id === message.id && entry.id !== '');
    if (at < 0) return false;
    const reply = path[at + 1];
    return !(reply !== undefined && reply.isAgent && reply.parentId === message.id);
  }

  protected isExpanded(message: AssistantMessage): boolean {
    return this.isLive(message) || this.openedBoxes().has(message.id);
  }

  protected toggleBox(message: AssistantMessage): void {
    this.openedBoxes.update((open) => {
      const next = new Set(open);
      if (next.has(message.id)) next.delete(message.id);
      else next.add(message.id);
      return next;
    });
  }

  /** The entry's row title: the tool name (unprefixed) + its first arg. */
  protected toolLabel(entry: AssistantToolEntry): string {
    const name = entry.toolName.replace(/^composer_/, '');
    const digest = argDigest(entry.args);
    return digest !== '' ? `${name} · ${digest}` : name;
  }

  /** Branch navigation: the sibling versions of a forked message. */
  protected branchOf(message: AssistantMessage): { position: number; count: number } | null {
    const thread = this.thread();
    if (!thread) return null;
    return this.assistant.branchOf(thread.id, message);
  }

  protected switchBranch(message: AssistantMessage, direction: -1 | 1): void {
    const thread = this.thread();
    if (!thread) return;
    const siblings = this.siblingsOf(thread.id, message);
    const at = siblings.findIndex((entry) => entry.id === message.id);
    const next = siblings[at + direction];
    if (next === undefined) return;
    this.assistant.switchBranch(thread.id, message.parentId, next.id);
  }

  private siblingsOf(threadId: string, message: AssistantMessage): AssistantMessage[] {
    const all = this.assistant.threads().get(threadId)?.messages ?? [];
    return all
      .filter((entry) => entry.parentId === message.parentId)
      .sort((a, b) => a.index - b.index);
  }

  // ---- Proposal panel (Phase 8) ----

  protected projectName(projectId: string): string {
    return this.shell.tabs().find((project) => project.id === projectId)?.name ?? projectId;
  }

  protected toggleInclude(index: number, checked: boolean): void {
    this.editItems.update((items) =>
      items.map((item, at) => (at === index ? { ...item, included: checked } : item)),
    );
  }

  protected editTitle(index: number, title: string): void {
    this.editItems.update((items) =>
      items.map((item, at) => (at === index ? { ...item, title } : item)),
    );
  }

  protected editDescription(index: number, description: string): void {
    this.editItems.update((items) =>
      items.map((item, at) => (at === index ? { ...item, description } : item)),
    );
  }

  protected editType(index: number, cardType: string): void {
    this.editItems.update((items) =>
      items.map((item, at) =>
        at === index ? { ...item, cardType: cardType as ProposalCardType } : item,
      ),
    );
  }

  protected async confirmProposal(): Promise<void> {
    const proposal = this.draftProposal();
    if (!proposal || this.confirming()) return;
    if (this.includedCount() === 0) {
      this.confirmError.set('nothing is included');
      return;
    }
    this.confirming.set(true);
    this.confirmError.set(null);
    const items: ProposalItem[] = this.editItems().map((item) => ({ ...item }));
    const failure = await this.assistant.confirmProposal(proposal.id, items);
    this.confirming.set(false);
    if (failure) this.confirmError.set(failure);
  }

  protected async discardProposal(): Promise<void> {
    const proposal = this.draftProposal();
    if (!proposal) return;
    const failure = await this.assistant.discardProposal(proposal.id);
    if (failure) this.confirmError.set(failure);
  }

  protected startEdit(message: AssistantMessage): void {    if (this.sending()) return;
    this.editing.set(message);
    this.draft.set(message.text);
    const area = this.composerArea()?.nativeElement;
    if (area) {
      area.focus();
      area.style.height = 'auto';
      area.style.height = `${Math.min(area.scrollHeight, 180)}px`;
    }
  }

  protected cancelEdit(): void {
    this.editing.set(null);
    this.draft.set('');
  }

  protected saveEdit(): void {
    const thread = this.thread();
    const original = this.editing();
    if (!thread || !original) return;
    const text = this.draft();
    if (text.trim() === '' || text === original.text) {
      this.cancelEdit();
      return;
    }
    void this.assistant.resendMessage(thread.id, original.id, text).then((sent) => {
      if (sent) this.cancelEdit();
    });
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
    if (this.editing()) {
      this.saveEdit();
      return;
    }
    const text = this.draft();
    this.pinned.set(true);
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

/** The first string arg (path, url, query) as the row's digest. */
function argDigest(args: unknown): string {
  if (typeof args !== 'object' || args === null) return '';
  const values = Object.values(args as Record<string, unknown>);
  const first = values.find((value) => typeof value === 'string' && value !== '');
  if (typeof first === 'string') return truncate(first, 48);
  if (values.length > 0) return truncate(JSON.stringify(args), 48);
  return '';
}

function truncate(value: string, cap: number): string {
  return value.length <= cap ? value : `${value.slice(0, cap)}…`;
}
