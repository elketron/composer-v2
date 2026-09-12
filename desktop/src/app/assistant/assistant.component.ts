import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, viewChild, ElementRef } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { MermaidDirective } from '../core/mermaid/mermaid.directive';
import { ShellService } from '../shell/shell.service';
import { ConfirmService } from '../core/confirm/confirm.service';
import { KnowledgeListComponent } from '../knowledge/knowledge-list.component';
import { KnowledgePaneComponent } from '../knowledge/knowledge-pane.component';
import { KnowledgeService } from '../knowledge/knowledge.service';
import {
  AssistantMessage,
  AssistantToolEntry,
  ProposalDraft,
  assistantToolLabel,
  type ProposalCardType,
} from '../core/models/assistant.models';
import { ProjectTab } from '../shell/shell.service';
import { AssistantService } from './assistant.service';

type AssistantTurnActivity =
  | { readonly kind: 'message'; readonly id: string; readonly text: string }
  | { readonly kind: 'tool'; readonly id: string; readonly tool: AssistantToolEntry };

/**
 * The global assistant (Phase 6): a thread sidebar, the transcript with its
 * live composer, and the project scope picker beside the conversation.
 * Scope changes publish wholesale; archive asks for confirmation. The
 * sidebar's second tab is the knowledge library (Phase 9 S30) with its
 * pane; agent messages offer a one-click "remember".
 */
@Component({
  selector: 'app-assistant',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MermaidDirective, KnowledgeListComponent, KnowledgePaneComponent],
  templateUrl: './assistant.component.html',
  styleUrl: './assistant.component.scss',
})
export class AssistantComponent {
  private readonly assistant = inject(AssistantService);
  private readonly shell = inject(ShellService);
  private readonly confirm = inject(ConfirmService);
  private readonly knowledge = inject(KnowledgeService);

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
  protected readonly proposalDraft = signal<ProposalDraft | null>(null);
  private readonly lastDraftId = signal('');
  protected readonly confirmError = signal<string | null>(null);
  protected readonly confirming = signal(false);
  protected readonly lastConfirmed = computed(
    () => this.proposals().find((proposal) => proposal.status === 'CONFIRMED') ?? null,
  );
  protected readonly editItems = computed(() => this.proposalDraft()?.items ?? []);
  protected readonly includedCount = computed(() => this.proposalDraft()?.includedCount() ?? 0);
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
  protected readonly scopeSaving = signal(false);

  // A signal so clearing it after send repaints under zoneless CD.
  protected readonly draft = signal('');
  protected readonly renaming = signal(false);
  protected readonly nameDraft = signal('');
  /** The user message being edited in the composer (edit-and-resend). */
  protected readonly editing = signal<AssistantMessage | null>(null);

  /**
   * The @-mention menu: the token after the caret's '@', or null (closed).
   * Typing filters the active projects; a chosen mention rides the message
   * and joins the thread's scope when it sends.
   */
  protected readonly mention = signal<string | null>(null);
  protected readonly mentionIndex = signal(0);
  /** Active projects matching the mention filter (prefix matches first). */
  protected readonly mentionMatches = computed<readonly ProjectTab[]>(() => {
    const query = (this.mention() ?? '').trim().toLowerCase();
    const projects = this.projects();
    const starts = projects.filter((project) => project.name.toLowerCase().startsWith(query));
    const includes = projects.filter(
      (project) =>
        !project.name.toLowerCase().startsWith(query) && project.name.toLowerCase().includes(query),
    );
    return [...starts, ...includes].slice(0, 8);
  });

  /** Tool-activity boxes the user opened manually (past turns). */
  private readonly openedBoxes = signal<ReadonlySet<string>>(new Set());

  /** The sidebar's pane: conversation threads or the knowledge library. */
  protected readonly pane = signal<'threads' | 'knowledge'>('threads');
  /** Agent messages already saved to knowledge (the button's feedback). */
  protected readonly remembered = signal<ReadonlySet<string>>(new Set());

  protected async switchPane(target: 'threads' | 'knowledge'): Promise<void> {
    if (target === this.pane()) return;
    // Leaving the knowledge pane with unsaved edits confirms first.
    if (this.pane() === 'knowledge' && !(await this.knowledge.confirmDiscard())) return;
    this.pane.set(target);
  }

  /**
   * Saves an agent reply into the knowledge library: the title is its
   * first line, the body the full markdown text. The button reports the
   * save per message.
   */
  protected async remember(message: AssistantMessage): Promise<void> {
    if (this.remembered().has(message.id)) return;
    const title = message.title;
    const result = await this.knowledge.create(title, [], message.text);
    if (result.ok) {
      this.remembered.update((saved) => new Set(saved).add(message.id));
    }
  }

  protected isRemembered(message: AssistantMessage): boolean {
    return message.id !== '' && this.remembered().has(message.id);
  }

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
        this.proposalDraft.set(ProposalDraft.fromProposal(draft));
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
  // (markdown rendering lives on AssistantMessage.markup(); the template
  // renders the message itself.)

  // ---- The working box (S25): a turn's tool activity ----

  /** Durable intermediate messages and tools of the turn this user message opened. */
  protected activityFor(message: AssistantMessage): AssistantTurnActivity[] {
    const thread = this.thread();
    if (!thread) return [];
    const messages = thread.messages
      .filter((entry) => entry.activity && entry.parentId === message.id)
      .sort((a, b) => a.index - b.index)
      .map((entry) => ({ kind: 'message' as const, id: `message-${entry.index}`, text: entry.text }));
    const tools = thread.toolCallsFor(message.id).map((tool) => ({
      kind: 'tool' as const,
      id: `tool-${tool.toolCallId}`,
      tool,
    }));
    return [...messages, ...tools];
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
    return assistantToolLabel(entry);
  }

  protected activityLabel(activity: readonly AssistantTurnActivity[]): string {
    const tools = activity.filter((entry) => entry.kind === 'tool').length;
    if (tools === activity.length) return `used ${tools} ${tools === 1 ? 'tool' : 'tools'}`;
    return `${activity.length} ${activity.length === 1 ? 'activity item' : 'activity items'}`;
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
      .filter((entry) => !entry.activity && entry.parentId === message.parentId)
      .sort((a, b) => a.index - b.index);
  }

  // ---- Proposal panel (Phase 8) ----

  protected projectName(projectId: string): string {
    return this.shell.tabs().find((project) => project.id === projectId)?.name ?? projectId;
  }

  protected toggleInclude(index: number, checked: boolean): void {
    this.proposalDraft.update((draft) => (draft ? draft.toggleInclude(index, checked) : draft));
  }

  protected editTitle(index: number, title: string): void {
    this.proposalDraft.update((draft) => (draft ? draft.setTitle(index, title) : draft));
  }

  protected editDescription(index: number, description: string): void {
    this.proposalDraft.update((draft) => (draft ? draft.setDescription(index, description) : draft));
  }

  protected editType(index: number, cardType: string): void {
    this.proposalDraft.update((draft) =>
      draft ? draft.setType(index, cardType as ProposalCardType) : draft,
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
    const items = this.proposalDraft()?.toItems() ?? [];
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
    this.closeMention();
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
    if (!thread || this.scopeSaving()) return;
    const draft = this.scopeDraft() ?? new Set(thread.projectIds);
    this.scopeSaving.set(true);
    const saved = await this.assistant.setScope(thread.id, [...draft]);
    this.scopeSaving.set(false);
    if (saved) this.scopeDraft.set(null);
  }

  protected send(): void {
    if (this.editing()) {
      this.saveEdit();
      return;
    }
    const text = this.draft();
    this.pinned.set(true);
    // Mentioned projects join the thread's scope on send (applied atomically
    // with the message, server-side).
    const scope = new Set(this.scopeDraft() ?? this.thread()?.projectIds ?? []);
    for (const id of mentionedProjectIds(text, this.projects())) scope.add(id);
    void this.assistant.sendMessage(text, [...scope]).then((sent) => {
      if (sent) {
        this.draft.set('');
        this.closeMention();
        const area = this.composerArea()?.nativeElement;
        if (area) area.style.height = 'auto';
      }
    });
  }

  /** The composer's input: grows the box and tracks the caret's @-token. */
  protected composerChange(text: string, area: HTMLTextAreaElement): void {
    this.draft.set(text);
    this.resize(area);
    this.trackMention(text, area);
  }

  /** Tracks the '@token before the caret: opens the menu, filters it. */
  private trackMention(text: string, area: HTMLTextAreaElement): void {
    const caret = area.selectionStart ?? text.length;
    const upto = text.slice(0, caret);
    const at = upto.lastIndexOf('@');
    if (at < 0 || (at > 0 && !/\s/.test(upto[at - 1]!))) {
      this.closeMention();
      return;
    }
    const query = upto.slice(at + 1);
    if (/\s/.test(query)) {
      this.closeMention();
      return;
    }
    this.mention.set(query);
    this.mentionIndex.set(0);
  }

  protected closeMention(): void {
    this.mention.set(null);
    this.mentionIndex.set(0);
  }

  /** Inserts the chosen mention in place of the '@token before the caret. */
  protected chooseMention(project: ProjectTab): void {
    const area = this.composerArea()?.nativeElement;
    const text = this.draft();
    const caret = area?.selectionStart ?? text.length;
    const upto = text.slice(0, caret);
    const at = upto.lastIndexOf('@');
    this.closeMention();
    if (at < 0) return;
    const inserted = `@${project.name} `;
    this.draft.set(upto.slice(0, at) + inserted + text.slice(caret));
    const nextCaret = at + inserted.length;
    if (area) {
      // The ngModel write paints the same value; place the caret after it.
      area.value = this.draft();
      area.setSelectionRange(nextCaret, nextCaret);
      area.focus();
      this.resize(area);
    }
  }

  /** Grows the composer with its content (up to the CSS cap). */
  protected resize(area: HTMLTextAreaElement): void {
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight, 180)}px`;
  }

  protected keydown(event: KeyboardEvent): void {
    if (this.mention() !== null) {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closeMention();
        return;
      }
      const matches = this.mentionMatches();
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (matches.length === 0) return;
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        this.mentionIndex.update((index) => (index + delta + matches.length) % matches.length);
        return;
      }
      if (matches.length > 0 && (event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
        event.preventDefault();
        this.chooseMention(matches[this.mentionIndex()] ?? matches[0]!);
        return;
      }
      // No matches: Enter falls through and sends the literal text.
    }
    // Enter sends; shift+enter (and alt/ctrl+enter) keep editing.
    if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    event.preventDefault();
    this.send();
  }
}

/** The ids of projects @-mentioned by full name (case-insensitive, tab order). */
function mentionedProjectIds(text: string, projects: readonly ProjectTab[]): string[] {
  const ids: string[] = [];
  for (const project of projects) {
    if (!ids.includes(project.id) && mentionsProject(text, project.name)) ids.push(project.id);
  }
  return ids;
}

/** A whole-token `@name` mention: bounded by whitespace/string edges. */
function mentionsProject(text: string, name: string): boolean {
  return new RegExp(`(^|\\s)@${escapeRegExp(name)}(?=$|[\\s,.;:!?])`, 'i').test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
