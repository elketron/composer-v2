import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import {
  FakeEventsClient,
  provideFakeEventsClient,
  seedProject,
  wireGlobalEvent,
} from '../core/events/events-client.fake';
import { ConfirmService } from '../core/confirm/confirm.service';
import { AssistantComponent } from './assistant.component';

describe('AssistantComponent', () => {
  let events: FakeEventsClient;

  beforeEach(async () => {
    events = new FakeEventsClient();
    await TestBed.configureTestingModule({
      imports: [AssistantComponent],
      providers: [provideFakeEventsClient(events), provideRouter([])],
    }).compileComponents();
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
});
