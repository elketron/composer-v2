import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';

import {
  FakeEventsClient,
  provideFakeEventsClient,
  seedProject,
  wireGlobalEvent,
} from '../core/events/events-client.fake';
import { ConfirmService } from '../core/confirm/confirm.service';
import { MERMAID_RENDERER, type MermaidRenderer } from '../core/mermaid/mermaid-renderer';
import { AssistantComponent } from './assistant.component';

/** Fake mermaid renderer: asserts the sanitized transcript path works. */
class FakeMermaid implements MermaidRenderer {
  readonly calls: string[] = [];
  render(code: string): Promise<string> {
    this.calls.push(code);
    return Promise.resolve(`<svg data-fake="${code.trim()}"></svg>`);
  }
}

describe('AssistantComponent', () => {
  let events: FakeEventsClient;
  let mermaid: FakeMermaid;
  let fetchJson: (url: string) => { status: number; body: unknown };

  beforeEach(async () => {
    events = new FakeEventsClient();
    mermaid = new FakeMermaid();
    await TestBed.configureTestingModule({
      imports: [AssistantComponent],
      providers: [
        provideFakeEventsClient(events),
        provideRouter([]),
        { provide: MERMAID_RENDERER, useValue: mermaid },
      ],
    }).compileComponents();
    fetchJson = () => ({ status: 200, body: {} });
    vi.spyOn(globalThis, 'fetch').mockImplementation(((url: string) => {
      const { status, body } = fetchJson(url);
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }) as typeof fetch);
  });

  function emitThread(overrides: Record<string, unknown> = {}): void {
    events.emit(
      wireGlobalEvent('assistantThreadCreated', {
        thread: {
          id: 'TH-1',
          name: 'Thread 1',
          createdAt: new Date().toISOString(),
          status: 'idle',
          projectIds: [],
          messages: [],
          ...overrides,
        },
      }),
    );
  }

  async function render(): Promise<HTMLElement> {
    const fixture = TestBed.createComponent(AssistantComponent);
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('shows the empty state and no composer before a thread exists', async () => {
    const el = await render();
    expect(el.textContent).toContain('start a thread to ask across projects');
    expect(el.querySelector('.conversation .state-empty')).toBeTruthy();
    expect(el.querySelector('.composer')).toBeNull();
  });

  it('lists threads, selects one, and shows its transcript', async () => {
    const fixture = TestBed.createComponent(AssistantComponent);
    emitThread({ createdAt: '2026-09-06T10:00:02Z' });
    emitThread({ id: 'TH-2', name: 'portfolio', createdAt: '2026-09-06T10:00:01Z' });
    events.emit(
      wireGlobalEvent('assistantUserMessage', {
        threadId: 'TH-1',
        message: { index: 1, role: 'user', text: 'what needs me?', at: '' },
      }),
    );
    events.emit(
      wireGlobalEvent('assistantMessageComplete', {
        threadId: 'TH-1',
        message: { index: 2, role: 'agent', text: 'Two projects need you.', at: '' },
      }),
    );
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    const rows = [...el.querySelectorAll('.thread-list .thread-row')];
    // Newest first.
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Thread 1'),
      expect.stringContaining('portfolio'),
    ]);

    // TH-1 auto-selected (the first snapshot thread): transcript visible.
    expect(el.textContent).toContain('what needs me?');
    expect(el.textContent).toContain('Two projects need you.');
    expect(el.querySelector('.composer')).toBeTruthy();
  });

  it('new thread publishes the create command', async () => {
    const el = await render();
    el.querySelector<HTMLElement>('.new-thread')?.click();
    expect(events.lastCommand('requestAssistantThreadCreate')).toMatchObject({
      projectId: '',
      requestAssistantThreadCreate: {},
    });
  });

  it('a failed create surfaces the rejection even with no thread to show', async () => {
    events.respondWith({
      ok: false,
      rejectionCode: 'invalidCommand',
      rejectionMessage: 'requestAssistantThreadCreate is not implemented yet',
    });
    const fixture = TestBed.createComponent(AssistantComponent);
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    el.querySelector<HTMLElement>('.new-thread')?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    const alert = el.querySelector<HTMLElement>('.conversation .state-error');
    expect(alert).toBeTruthy();
    expect(alert?.textContent).toContain('not implemented yet');
    // The empty state stays visible (no thread landed).
    expect(el.querySelector('.conversation .state-empty')).toBeTruthy();
  });

  it('sending publishes the message and clears the draft', async () => {
    const fixture = TestBed.createComponent(AssistantComponent);
    emitThread();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    const area = el.querySelector<HTMLTextAreaElement>('.composer textarea')!;
    area.value = 'what needs me?';
    area.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    fixture.detectChanges();

    el.querySelector<HTMLButtonElement>('.composer .send')?.click();
    await fixture.whenStable();
    expect(events.lastCommand('requestAssistantMessage')).toMatchObject({
      projectId: '',
      requestAssistantMessage: { threadId: 'TH-1', text: 'what needs me?' },
    });
  });

  it('the scope picker drafts from the thread scope and applies wholesale', async () => {
    const fixture = TestBed.createComponent(AssistantComponent);
    seedProject(events, 'P-1', 'alpha');
    seedProject(events, 'P-2', 'beta');
    emitThread({ projectIds: ['P-1'] });
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    // The scope chips stay visible beside the conversation.
    expect(el.querySelector('.scope-picker summary')?.textContent).toContain('alpha');

    // jsdom does not toggle <details> on summary click; open + signal it.
    const details = el.querySelector<HTMLDetailsElement>('.scope-picker')!;
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    await fixture.whenStable();
    fixture.detectChanges();

    const options = [...el.querySelectorAll<HTMLInputElement>('.scope-option input')];
    expect(options.map((option) => option.checked)).toEqual([true, false]);
    options[1]!.click();
    await fixture.whenStable();
    el.querySelector<HTMLElement>('.scope-save')?.click();
    await fixture.whenStable();

    expect(events.lastCommand('requestAssistantThreadScope')).toMatchObject({
      projectId: '',
      requestAssistantThreadScope: { threadId: 'TH-1', projectIds: ['P-1', 'P-2'] },
    });
  });

  it('archiving waits on the confirmation dialog before publishing', async () => {
    const fixture = TestBed.createComponent(AssistantComponent);
    emitThread();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    el.querySelector<HTMLElement>('.thread-row .archive')?.click();
    await fixture.whenStable();
    expect(events.published).toEqual([]); // nothing published while pending

    const confirm = TestBed.inject(ConfirmService);
    confirm.resolve(true);
    await fixture.whenStable();
    expect(events.lastCommand('requestAssistantThreadArchive')).toMatchObject({
      projectId: '',
      requestAssistantThreadArchive: { threadId: 'TH-1' },
    });
  });

  it('a running thread offers stop; an idle one offers retry', async () => {
    const fixture = TestBed.createComponent(AssistantComponent);
    emitThread();
    events.emit(
      wireGlobalEvent('assistantUserMessage', {
        threadId: 'TH-1',
        message: { index: 1, role: 'user', text: 'long question', at: '' },
      }),
    );
    await fixture.whenStable();
    fixture.detectChanges();
    let el = fixture.nativeElement as HTMLElement;

    el.querySelector<HTMLElement>('.control.stop')?.click();
    await fixture.whenStable();
    expect(events.lastCommand('requestAssistantThreadStop')).toMatchObject({
      projectId: '',
      requestAssistantThreadStop: { threadId: 'TH-1' },
    });

    // The stop lands: the thread is no longer running and the retry shows.
    events.emit(wireGlobalEvent('assistantThreadStopped', { threadId: 'TH-1' }));
    await fixture.whenStable();
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.control.stop')).toBeNull();
    el.querySelector<HTMLElement>('.control:not(.stop)')?.click();
    await fixture.whenStable();
    expect(events.lastCommand('requestAssistantRetry')).toMatchObject({
      projectId: '',
      requestAssistantRetry: { threadId: 'TH-1' },
    });
  });

  it('the thread title starts an inline rename that publishes on commit', async () => {
    const fixture = TestBed.createComponent(AssistantComponent);
    emitThread({ name: 'Thread 1' });
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    el.querySelector<HTMLElement>('.thread-title')?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    const input = el.querySelector<HTMLInputElement>('.rename-input')!;
    expect(input).toBeTruthy();
    input.value = 'portfolio';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await fixture.whenStable();

    expect(events.lastCommand('requestAssistantThreadRename')).toMatchObject({
      projectId: '',
      requestAssistantThreadRename: { threadId: 'TH-1', name: 'portfolio' },
    });
  });

  it('agent replies render as safe markdown; injected tags stay literal', async () => {
    const fixture = TestBed.createComponent(AssistantComponent);
    emitThread();
    events.emit(
      wireGlobalEvent('assistantUserMessage', {
        threadId: 'TH-1',
        message: { index: 1, role: 'user', text: 'explain', at: '' },
      }),
    );
    events.emit(
      wireGlobalEvent('assistantMessageComplete', {
        threadId: 'TH-1',
        message: {
          index: 2,
          role: 'agent',
          text: 'Use **bold**.\n\n```ts\nconst x = 1;\n```\n\n<script>alert(1)</script>',
          at: '',
        },
      }),
    );
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    const bubble = el.querySelector<HTMLElement>('.message.agent .message-text.markdown')!;
    expect(bubble).toBeTruthy();
    expect(bubble.querySelector('strong')?.textContent).toBe('bold');
    expect(bubble.querySelector('pre code')).toBeTruthy();
    // Raw HTML was escaped before parsing: no script element exists.
    expect(bubble.querySelector('script')).toBeNull();
    expect(bubble.textContent).toContain('<script>');
  });

  it('a mermaid fence in an agent reply renders as a diagram (sanitizer-safe path)', async () => {
    const fixture = TestBed.createComponent(AssistantComponent);
    emitThread();
    events.emit(
      wireGlobalEvent('assistantMessageComplete', {
        threadId: 'TH-1',
        message: {
          index: 1,
          role: 'agent',
          text: 'Here is the flow:\n\n```mermaid\ngraph TD; A-->B;\n```',
          at: '',
        },
      }),
    );
    await fixture.whenStable();
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    // The class attribute survives Angular's sanitizer on this (non-bypass)
    // innerHTML path, so the enhancer finds the fence and renders it.
    expect(mermaid.calls).toEqual(['graph TD; A-->B;']);
    const bubble = el.querySelector<HTMLElement>('.message.agent .message-text.markdown')!;
    expect(bubble.querySelector('svg[data-fake="graph TD; A-->B;"]')).toBeTruthy();
    expect(bubble.querySelector('code.language-mermaid')).toBeNull();
  });

  it('the knowledge tab swaps the sidebar and main pane', async () => {
    fetchJson = () => ({ status: 200, body: { entries: [] } });
    const fixture = TestBed.createComponent(AssistantComponent);
    emitThread();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.transcript')).toBeTruthy();

    const tabs = [...el.querySelectorAll<HTMLButtonElement>('.pane-tab')];
    tabs.find((tab) => tab.textContent?.trim() === 'knowledge')!.click();
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(el.querySelector('.transcript')).toBeNull();
    expect(el.querySelector('app-knowledge-pane')).toBeTruthy();
    expect(el.querySelector('app-knowledge-list')).toBeTruthy();

    const back = [...el.querySelectorAll<HTMLButtonElement>('.pane-tab')].find(
      (tab) => tab.textContent?.trim() === 'threads',
    )!;
    back.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    expect(el.querySelector('.transcript')).toBeTruthy();
  });

  it('remember saves an agent reply as a knowledge note (once)', async () => {
    const fixture = TestBed.createComponent(AssistantComponent);
    emitThread();
    events.emit(
      wireGlobalEvent('assistantMessageComplete', {
        threadId: 'TH-1',
        message: {
          id: 'am-1',
          index: 1,
          role: 'agent',
          text: '## Deploy pipeline\n\nRuns on fridays.',
          at: '',
        },
      }),
    );
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    const button = el.querySelector<HTMLButtonElement>('.message.agent .remember')!;
    expect(button.textContent?.trim()).toBe('remember');
    button.click();
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(events.lastCommand('requestKnowledgeSave')).toEqual({
      requestKnowledgeSave: { title: 'Deploy pipeline', tags: [], content: '## Deploy pipeline\n\nRuns on fridays.' },
    });
    expect(el.querySelector<HTMLButtonElement>('.message.agent .remember')?.textContent?.trim()).toBe('saved ✓');
  });

  it('edit loads the message into the composer and resend publishes the sibling', async () => {
    const fixture = TestBed.createComponent(AssistantComponent);
    emitThread();
    events.emit(
      wireGlobalEvent('assistantUserMessage', {
        threadId: 'TH-1',
        message: { id: 'u1', index: 1, role: 'user', text: 'original question', at: '' },
      }),
    );
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    el.querySelector<HTMLElement>('.message-tools .edit')?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(el.querySelector('.editing-bar')).toBeTruthy();
    const area = el.querySelector<HTMLTextAreaElement>('.composer textarea')!;
    expect(area.value).toBe('original question');

    area.value = 'edited question';
    area.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    el.querySelector<HTMLButtonElement>('.composer .send')?.click();
    await fixture.whenStable();

    expect(events.lastCommand('requestAssistantResend')).toMatchObject({
      projectId: '',
      requestAssistantResend: { threadId: 'TH-1', messageId: 'u1', text: 'edited question' },
    });
  });

  it('the branch switcher navigates between sibling versions', async () => {
    const fixture = TestBed.createComponent(AssistantComponent);
    emitThread();
    events.emit(
      wireGlobalEvent('assistantUserMessage', {
        threadId: 'TH-1',
        message: { id: 'u1', index: 1, role: 'user', text: 'original', at: '' },
      }),
    );
    events.emit(
      wireGlobalEvent('assistantResent', {
        threadId: 'TH-1',
        message: { id: 'u2', index: 3, role: 'user', text: 'edited', at: '' },
      }),
    );
    await fixture.whenStable();
    fixture.detectChanges();
    let el = fixture.nativeElement as HTMLElement;

    // The newest sibling shows by default (2/2).
    expect(el.textContent).toContain('edited');
    expect(el.querySelector('.branch-position')?.textContent).toContain('2/2');

    el.querySelector<HTMLElement>('.branch-nav[aria-label="previous version"]')?.click();
    await fixture.whenStable();
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('original');
    expect(el.querySelector('.branch-position')?.textContent).toContain('1/2');
  });

  // ---- Proposal panel (Phase 8) ----

  function emitProposalDraft(): void {
    events.emit(
      wireGlobalEvent('proposalDrafted', {
        proposal: {
          id: 'PR-1',
          threadId: 'TH-1',
          createdAt: new Date().toISOString(),
          status: 'drafted',
          items: [
            { id: 'pi-1', projectId: 'P-1', title: 'First item', description: 'do it', cardType: 'coding', key: 'a', blockedBy: [], included: true },
            { id: 'pi-2', projectId: 'P-1', title: 'Second item', description: '', cardType: 'docs', blockedBy: ['a'], included: true },
          ],
        },
      }),
    );
  }

  it('a drafted proposal renders editable items and confirms through the panel', async () => {
    const fixture = TestBed.createComponent(AssistantComponent);
    seedProject(events, 'P-1', 'alpha');
    emitThread();
    emitProposalDraft();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('.proposal')).toBeTruthy();
    expect(el.textContent).toContain('proposal PR-1');
    const titles = [...el.querySelectorAll('.proposal-title')].map((input) => (input as HTMLInputElement).value);
    expect(titles).toEqual(['First item', 'Second item']);

    // Edit a title and exclude one item; confirm publishes both.
    const titleInput = el.querySelectorAll<HTMLInputElement>('.proposal-title')[1]!;
    titleInput.value = 'Second (edited)';
    titleInput.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    el.querySelector<HTMLInputElement>('.proposal-item input[type="checkbox"]')?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(el.querySelector<HTMLButtonElement>('.proposal-confirm')?.disabled).toBe(false);
    el.querySelector<HTMLButtonElement>('.proposal-confirm')?.click();
    await fixture.whenStable();
    expect(events.lastCommand('requestProposalConfirm')).toMatchObject({
      projectId: '',
      requestProposalConfirm: { proposalId: 'PR-1' },
    });
    const payload = events.lastCommand('requestProposalConfirm')?.requestProposalConfirm;
    expect(payload?.items[0]?.included).toBe(false);
    expect(payload?.items[1]?.title).toBe('Second (edited)');
  });

  it('confirming with nothing included is blocked client-side', async () => {
    const fixture = TestBed.createComponent(AssistantComponent);
    emitThread();
    emitProposalDraft();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    for (const checkbox of el.querySelectorAll<HTMLInputElement>('.proposal-item input[type="checkbox"]')) {
      checkbox.click();
    }
    await fixture.whenStable();
    fixture.detectChanges();

    expect(el.querySelector<HTMLButtonElement>('.proposal-confirm')?.disabled).toBe(true);
    el.querySelector<HTMLButtonElement>('.proposal-confirm')?.click();
    await fixture.whenStable();
    expect(events.published).toEqual([]);
  });

  it('the working box shows a running turn live and collapses when the reply lands', async () => {
    const fixture = TestBed.createComponent(AssistantComponent);
    emitThread();
    events.emit(
      wireGlobalEvent('assistantUserMessage', {
        threadId: 'TH-1',
        message: { index: 1, role: 'user', text: 'what needs me?', at: '', id: 'am-1' },
      }),
    );
    events.emit(
      wireGlobalEvent('assistantToolCall', {
        threadId: 'TH-1',
        parentId: 'am-1',
        toolCallId: 'at-1',
        toolName: 'composer_overview',
        args: {},
      }),
    );
    events.emit(
      wireGlobalEvent('assistantToolCall', {
        threadId: 'TH-1',
        parentId: 'am-1',
        toolCallId: 'at-2',
        toolName: 'read_file',
        args: { path: 'src/app/app.ts' },
      }),
    );
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    // Live: the box is open under the turn's user message, rows stream in.
    const box = el.querySelector('.tool-activity');
    expect(box?.classList.contains('live')).toBe(true);
    expect(box?.textContent).toContain('working…');
    expect([...el.querySelectorAll('.tool-entry:not(.activity-message) .tool-name')].map((name) => name.textContent?.trim())).toEqual([
      'overview',
      'read_file · src/app/app.ts',
    ]);
    expect(el.querySelector('.tool-summary.pending')).toBeTruthy();

    // A settled result patches its row in place.
    events.emit(
      wireGlobalEvent('assistantToolResult', {
        threadId: 'TH-1',
        toolCallId: 'at-1',
        summary: 'Two projects need you.',
        isError: false,
      }),
    );
    await fixture.whenStable();
    fixture.detectChanges();
    expect(box?.textContent).toContain('Two projects need you.');

    // The reply lands: the box collapses to its one-line summary, as a
    // full-width strip of its own between the two bubbles.
    events.emit(
      wireGlobalEvent('assistantMessageComplete', {
        threadId: 'TH-1',
        message: { index: 2, role: 'agent', text: 'Done.', at: '', id: 'am-2', parentId: 'am-1' },
      }),
    );
    await fixture.whenStable();
    fixture.detectChanges();
    const collapsed = el.querySelector('.tool-activity');
    expect(collapsed?.classList.contains('live')).toBe(false);
    expect(collapsed?.textContent).toContain('used 2 tools');
    expect(el.querySelector('.tool-list')).toBeNull();
    const children = [...el.querySelector('.transcript')!.children];
    const userAt = children.findIndex((child) => child.classList.contains('user'));
    const boxAt = children.findIndex((child) => child.classList.contains('tool-activity'));
    const agentAt = children.findIndex((child) => child.classList.contains('agent'));
    expect(boxAt).toBeGreaterThan(userAt);
    expect(agentAt).toBeGreaterThan(boxAt);

    // A past turn's box expands on demand and keeps its rows.
    collapsed?.querySelector<HTMLButtonElement>('.tool-activity-head')?.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('.tool-list')).toBeTruthy();
    expect(el.querySelector('.tool-activity')?.textContent).toContain('Two projects need you.');
  });

  it('a turn with no recorded activity still renders its live stream in the box', async () => {
    const fixture = TestBed.createComponent(AssistantComponent);
    emitThread();
    events.emit(
      wireGlobalEvent('assistantUserMessage', {
        threadId: 'TH-1',
        message: { index: 1, role: 'user', text: 'hello', at: '', id: 'am-1' },
      }),
    );
    await fixture.whenStable();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.tool-activity.live')?.textContent).toContain('thinking…');

    events.emit(
      wireGlobalEvent('assistantMessageComplete', {
        threadId: 'TH-1',
        message: { index: 2, role: 'agent', text: 'hello', at: '', id: 'am-2', parentId: 'am-1' },
      }),
    );
    await fixture.whenStable();
    fixture.detectChanges();
    expect(element.querySelector('.tool-activity')).toBeNull();
  });
});
