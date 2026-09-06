import { TestBed } from '@angular/core/testing';

import {
  FakeEventsClient,
  provideFakeEventsClient,
  wireGlobalEvent,
} from '../core/events/events-client.fake';
import { AssistantService } from './assistant.service';

/**
 * AssistantService over the event stream: the assistant lives server-side,
 * so the service publishes commands and folds the assistant event family
 * (global frames — no projectId).
 */
describe('AssistantService', () => {
  let service: AssistantService;
  let events: FakeEventsClient;

  beforeEach(() => {
    events = new FakeEventsClient();
    TestBed.configureTestingModule({ providers: [provideFakeEventsClient(events)] });
    service = TestBed.inject(AssistantService);
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

  it('has no thread until one exists; the first snapshot thread selects itself', () => {
    expect(service.thread()).toBeNull();
    expect(events.published).toEqual([]);
    emitThread();
    expect(service.thread()?.id).toBe('TH-1');
    expect(events.published).toEqual([]);
  });

  it('createThread publishes without scope and the echo selects the thread', async () => {
    emitThread(); // an existing thread is active
    const created = service.createThread('portfolio');
    expect(events.lastCommand('requestAssistantThreadCreate')).toMatchObject({
      projectId: '',
      requestAssistantThreadCreate: { name: 'portfolio' },
    });
    events.emit(
      wireGlobalEvent('assistantThreadCreated', {
        thread: { id: 'TH-2', name: 'portfolio', createdAt: new Date().toISOString(), status: 'idle', projectIds: [], messages: [] },
      }),
    );
    await created;
    expect(service.thread()?.id).toBe('TH-2');
  });

  it('a snapshot re-delivery does not steal the selection', () => {
    emitThread({ createdAt: '2026-09-06T10:00:02Z' });
    emitThread({ id: 'TH-2', name: 'Thread 2', createdAt: '2026-09-06T10:00:01Z' }); // a second thread arrives
    // The active thread stays TH-1 (only the first auto-selects).
    expect(service.thread()?.id).toBe('TH-1');
    expect(service.activeThreads().map((thread) => thread.id)).toEqual(['TH-1', 'TH-2']);
  });

  it('a send on an empty state creates a thread, publishes the message, and clears on the reply', async () => {
    const sent = service.sendMessage('what needs me?');
    emitThread();
    expect(await sent).toBe(true);
    expect(events.lastCommand('requestAssistantMessage')).toMatchObject({
      projectId: '',
      requestAssistantMessage: { threadId: 'TH-1', text: 'what needs me?' },
    });
    expect(service.isSending()).toBe(true);

    // The user message re-opens the transcript, the reply closes it.
    events.emit(
      wireGlobalEvent('assistantUserMessage', {
        threadId: 'TH-1',
        message: { index: 1, role: 'user', text: 'what needs me?', at: '' },
      }),
    );
    expect(service.thread()?.status).toBe('RUNNING');

    events.emit(
      wireGlobalEvent('assistantMessageDelta', {
        threadId: 'TH-1',
        messageIndex: 2,
        delta: 'Two ',
      }),
    );
    expect(service.streamingMessage()?.text).toBe('Two ');
    events.emit(
      wireGlobalEvent('assistantMessageDelta', {
        threadId: 'TH-1',
        messageIndex: 2,
        delta: 'projects',
      }),
    );
    expect(service.streamingMessage()?.text).toBe('Two projects');

    events.emit(
      wireGlobalEvent('assistantMessageComplete', {
        threadId: 'TH-1',
        message: { index: 2, role: 'agent', text: 'Two projects', at: '' },
      }),
    );
    expect(service.streamingMessage()).toBeNull();
    expect(service.isSending()).toBe(false);
    expect(service.thread()?.status).toBe('IDLE');
    expect(service.messages().map((message) => message.text)).toEqual([
      'what needs me?',
      'Two projects',
    ]);
  });

  it('a reply never steals a user message slot (the server folds the same heal)', () => {
    emitThread();
    events.emit(
      wireGlobalEvent('assistantUserMessage', {
        threadId: 'TH-1',
        message: { index: 1, role: 'user', text: 'first', at: '' },
      }),
    );
    // The second user message folded onto the reply's reserved index.
    events.emit(
      wireGlobalEvent('assistantUserMessage', {
        threadId: 'TH-1',
        message: { index: 2, role: 'user', text: 'second', at: '' },
      }),
    );
    // The reply's completion arrives with the stale index 2.
    events.emit(
      wireGlobalEvent('assistantMessageComplete', {
        threadId: 'TH-1',
        message: { index: 2, role: 'agent', text: 'first reply', at: '' },
      }),
    );
    expect(service.messages().map((message) => `${message.role}:${message.text}`)).toEqual([
      'user:first',
      'user:second',
      'agent:first reply',
    ]);
  });

  it('scope changes fold and publish wholesale', async () => {
    emitThread();
    await service.setScope('TH-1', ['P-1', 'P-2']);
    expect(events.lastCommand('requestAssistantThreadScope')).toMatchObject({
      projectId: '',
      requestAssistantThreadScope: { threadId: 'TH-1', projectIds: ['P-1', 'P-2'] },
    });
    events.emit(
      wireGlobalEvent('assistantThreadScopeChanged', { threadId: 'TH-1', projectIds: ['P-2'] }),
    );
    expect(service.thread()?.projectIds).toEqual(['P-2']);
  });

  it('archiving the active thread selects the next active one; restore brings it back', async () => {
    emitThread({ createdAt: '2026-09-06T10:00:02Z' });
    emitThread({ id: 'TH-2', name: 'Thread 2', createdAt: '2026-09-06T10:00:01Z' });
    service.select('TH-2');

    expect(await service.archiveThread('TH-2')).toBeNull();
    expect(events.lastCommand('requestAssistantThreadArchive')).toMatchObject({
      projectId: '',
      requestAssistantThreadArchive: { threadId: 'TH-2' },
    });
    events.emit(
      wireGlobalEvent('assistantThreadArchived', { threadId: 'TH-2', archivedAt: new Date().toISOString() }),
    );
    expect(service.thread()?.id).toBe('TH-1');
    expect(service.archivedThreads().map((thread) => thread.id)).toEqual(['TH-2']);

    expect(await service.restoreThread('TH-2')).toBeNull();
    events.emit(
      wireGlobalEvent('assistantThreadRestored', { threadId: 'TH-2', restoredAt: new Date().toISOString() }),
    );
    expect(service.archivedThreads()).toEqual([]);
  });

  it('a rejected message surfaces its message and clears the send lock', async () => {
    emitThread();
    events.respondWith({ ok: false, rejectionCode: 'invalidCommand', rejectionMessage: 'Message text is required' });
    const sent = service.sendMessage('hello');
    expect(await sent).toBe(false);
    expect(service.error()).toBe('Message text is required');
    expect(service.isSending()).toBe(false);
  });
});
