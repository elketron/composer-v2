import { TestBed } from '@angular/core/testing';

import {
  FakeEventsClient,
  provideFakeEventsClient,
  wireCard,
  wireEvent,
} from '../core/events/events-client.fake';
import { PlanService } from './plan.service';

/**
 * PlanService over the event stream: the planner lives server-side, so the
 * service publishes commands and folds their echoes (and the planner's
 * events) instead of simulating turns locally.
 */
describe('PlanService', () => {
  let service: PlanService;
  let events: FakeEventsClient;

  beforeEach(() => {
    events = new FakeEventsClient();
    TestBed.configureTestingModule({ providers: [provideFakeEventsClient(events)] });
    service = TestBed.inject(PlanService);
    events.emit(
      wireEvent(
        'projectCreated',
        { project: { id: 'P-1', name: 'alpha', createdAt: new Date().toISOString() } },
        'P-1',
      ),
    );
    service.setProject('P-1');
  });

  function emitSession(sessionId = 'S-1') {
    events.emit(
      wireEvent(
        'planningSessionCreated',
        { session: { id: sessionId, projectId: 'P-1', createdAt: new Date().toISOString() } },
        'P-1',
      ),
    );
  }

  function emitDocument(document: string, sessionId = 'S-1') {
    events.emit(wireEvent('planDocumentUpdated', { sessionId, document }, 'P-1'));
  }

  /** Drive a send through session creation and the user-message publish. */
  async function send(text: string): Promise<boolean> {
    const promise = service.sendMessage(text);
    emitSession();
    return promise;
  }

  it('has no session until the first send creates one (lazy, race-free)', () => {
    expect(service.session()).toBeNull();
    expect(events.published).toEqual([]);
  });

  it('folds a snapshot session without creating a new one', () => {
    emitSession();
    expect(service.session()?.id).toBe('S-1');
    expect(events.published).toEqual([]);
  });

  it('requestNewSession replaces a populated session with the fresh echo', () => {
    // The active session is populated (document + a message).
    emitSession();
    service.applyServerEvent({
      type: 'PlanDocumentUpdated',
      sessionId: 'S-1',
      document: '<plan><goal>the old plan</goal></plan>',
    } as never);
    events.emit(
      wireEvent('userMessageReceived', {
        sessionId: 'S-1',
        message: { index: 1, role: 'user', text: 'the old direction', at: '' },
      }),
    );

    service.requestNewSession();
    expect(events.lastCommand('requestPlanningSessionCreate')).toMatchObject({
      projectId: 'P-1',
      requestPlanningSessionCreate: {},
    });

    // The fresh echo (different id, empty) lands — we asked for it.
    events.emit(
      wireEvent('planningSessionCreated', {
        session: { id: 'S-2', projectId: 'P-1', createdAt: '', status: 'drafting', messages: [], planDocument: '' },
      }),
    );
    expect(service.session()?.id).toBe('S-2');
    expect(service.messages()).toEqual([]);
    expect(service.planDocument()).toBe('');
  });

  it('a stale echo (no create in flight) still cannot clobber a populated session', () => {
    emitSession();
    service.applyServerEvent({
      type: 'PlanDocumentUpdated',
      sessionId: 'S-1',
      document: '<plan><goal>the old plan</goal></plan>',
    } as never);
    events.emit(
      wireEvent('planningSessionCreated', {
        session: { id: 'S-9', projectId: 'P-1', createdAt: '', status: 'drafting', messages: [], planDocument: '' },
      }),
    );
    expect(service.session()?.id).toBe('S-1');
  });

  describe('sendMessage', () => {
    it('creates the session on first send, then publishes the user message', async () => {
      const promise = service.sendMessage('Build a board');
      emitSession();

      expect(await promise).toBe(true);
      const kinds = events.published.map((c) => FakeEventsClient.commandKind(c));
      expect(kinds).toEqual(['requestPlanningSessionCreate', 'requestUserMessage']);
      expect(events.lastCommand('requestUserMessage')?.requestUserMessage).toEqual({
        sessionId: 'S-1',
        text: 'Build a board',
      });
    });

    it('reuses the existing session on later sends', async () => {
      emitSession();
      expect(await service.sendMessage('one')).toBe(true);
      // The input unlocks when the planner's turn completes.
      events.emit(
        wireEvent(
          'agentMessageComplete',
          {
            sessionId: 'S-1',
            message: { index: 2, role: 'agent', text: 'ok', at: new Date().toISOString() },
          },
          'P-1',
        ),
      );
      expect(await service.sendMessage('two')).toBe(true);

      expect(events.lastCommand('requestPlanningSessionCreate')).toBeUndefined();
      const userMessages = events.published.filter(
        (c) => FakeEventsClient.commandKind(c) === 'requestUserMessage',
      );
      expect(userMessages.length).toBe(2);
    });

    it('surfaces a publish rejection as an error', async () => {
      emitSession();
      events.respondWith({ ok: false, rejectionMessage: 'unknown session' });

      expect(await service.sendMessage('hello')).toBe(false);
      expect(service.error()).toBe('unknown session');
      expect(service.isSending()).toBe(false);
    });
  });

  describe('folds', () => {
    beforeEach(async () => {
      expect(await send('Build a board')).toBe(true);
      events.emit(
        wireEvent(
          'userMessageReceived',
          {
            sessionId: 'S-1',
            message: { index: 1, role: 'user', text: 'Build a board', at: new Date().toISOString() },
          },
          'P-1',
        ),
      );
    });

    it('folds a chat turn with deltas', () => {
      events.emit(
        wireEvent('agentMessageDelta', { sessionId: 'S-1', messageIndex: 2, delta: 'I see ' }, 'P-1'),
      );
      events.emit(
        wireEvent(
          'agentMessageDelta',
          { sessionId: 'S-1', messageIndex: 2, delta: 'a direction.' },
          'P-1',
        ),
      );

      expect(service.isSending()).toBe(true);
      expect(service.streamingMessage()?.text).toBe('I see a direction.');

      events.emit(
        wireEvent(
          'agentMessageComplete',
          {
            sessionId: 'S-1',
            message: { index: 2, role: 'agent', text: 'I see a direction.', at: new Date().toISOString() },
          },
          'P-1',
        ),
      );

      expect(service.isSending()).toBe(false);
      expect(service.streamingMessage()).toBeNull();
      expect(service.messages().map((m) => `${m.role}:${m.index}`)).toEqual(['user:1', 'agent:2']);
    });

    it('clears the stream when the completion lands under a different index', () => {
      // Observed live: deltas numbered the message 2, the completion called
      // it 3 — the old index-matching left a stuck, duplicated bubble.
      events.emit(
        wireEvent('agentMessageDelta', { sessionId: 'S-1', messageIndex: 2, delta: 'half ' }, 'P-1'),
      );
      events.emit(
        wireEvent('agentMessageDelta', { sessionId: 'S-1', messageIndex: 2, delta: 'answer' }, 'P-1'),
      );
      events.emit(
        wireEvent(
          'agentMessageComplete',
          {
            sessionId: 'S-1',
            message: { index: 3, role: 'agent', text: 'half answer', at: new Date().toISOString() },
          },
          'P-1',
        ),
      );

      expect(service.streamingMessage()).toBeNull();
      expect(service.isSending()).toBe(false);
      expect(service.messages().map((m) => `${m.role}:${m.index}`)).toEqual(['user:1', 'agent:3']);
      // The transcript renders each slot once.
      const keys = service.messages().map((m) => `${m.role}-${m.index}`);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('folds plan document updates wholesale', () => {
      emitDocument('<plan>\n<goal>a board</goal>\n</plan>');
      expect(service.planDocument()).toBe('<plan>\n<goal>a board</goal>\n</plan>');
      // The document lives on the session.
      expect(service.session()?.planDocument).toBe('<plan>\n<goal>a board</goal>\n</plan>');

      emitDocument('<plan>\n<goal>a board v2</goal>\n</plan>');
      expect(service.planDocument()).toBe('<plan>\n<goal>a board v2</goal>\n</plan>');
    });

    it('folds session completion into the done status', () => {
      expect(service.status()).toBe('DRAFTING');
      expect(service.isDone()).toBe(false);

      events.emit(wireEvent('planningSessionCompleted', { sessionId: 'S-1' }, 'P-1'));

      expect(service.status()).toBe('DONE');
      expect(service.isDone()).toBe(true);
    });

    it('folds duplicate identified events only once', () => {
      const event = wireEvent(
        'planDocumentUpdated',
        { sessionId: 'S-1', document: 'once' },
        'P-1',
      );

      events.emit(event);
      events.emit(event);

      expect(service.planDocument()).toBe('once');
    });

    it('folds CardsCommitted into committedCards', () => {
      events.emit(
        wireEvent(
          'cardsCommitted',
          { cards: [wireCard({ id: 'T-1' }), wireCard({ id: 'T-2', blockedBy: ['T-1'] })] },
          'P-1',
        ),
      );

      expect(service.committedCards().map((card) => card.id)).toEqual(['T-1', 'T-2']);
    });

    it('keeps the populated session when a different empty session is created', () => {
      events.emit(
        wireEvent(
          'planningSessionCreated',
          { session: { id: 'S-2', projectId: 'P-1', createdAt: new Date().toISOString() } },
          'P-1',
        ),
      );
      expect(service.session()?.id).toBe('S-1');
    });
  });
});
