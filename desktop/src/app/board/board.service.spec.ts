import { TestBed } from '@angular/core/testing';

import {
  FakeEventsClient,
  provideFakeEventsClient,
  wireCard,
  wireEvent,
} from '../core/events/events-client.fake';
import {
  WireCardType,
  WireRejectionCode,
  WireStage,
  WireSubStateStatus,
  stageToWire,
} from '../core/events/wire';
import { Card, Lane, Stage } from '../core/models/board.models';
import { BoardService } from './board.service';

/**
 * BoardService over the event stream: wire events fold into the same signals
 * the mock used to seed; commands publish optimistically and revert on a
 * typed rejection.
 */
describe('BoardService', () => {
  let service: BoardService;
  let events: FakeEventsClient;

  beforeEach(() => {
    events = new FakeEventsClient();
    TestBed.configureTestingModule({ providers: [provideFakeEventsClient(events)] });
    service = TestBed.inject(BoardService);
    activateProject('P-1');
  });

  /** Fold a project (and activate it) plus any cards, like a snapshot would. */
  function activateProject(projectId: string, cards: Parameters<typeof wireCard>[0][] = []) {
    events.emit(
      wireEvent(
        'projectCreated',
        { project: { id: projectId, name: projectId, createdAt: new Date().toISOString() } },
        projectId,
      ),
    );
    for (const card of cards) {
      events.emit(wireEvent('cardCreated', { card: wireCard({ projectId, ...card }) }, projectId));
    }
  }

  function emitCardMoved(cardId: string, to: WireStage, comment = '', projectId = 'P-1') {
    events.emit(wireEvent('cardMoved', { cardId, to, comment }, projectId));
  }

  it('folds CardCreated into the board and derives blocked cards', () => {
    activateProject('P-1', [
      { id: 'T-1', stage: WireStage.STAGE_CODING },
      { id: 'T-2', blockedBy: ['T-1'] },
    ]);
    TestBed.tick();

    expect(service.cards().map((c) => c.id)).toEqual(['T-1', 'T-2']);
    expect(service.blockedIds().has('T-2')).toBe(true);
    expect(service.blockedIds().has('T-1')).toBe(false);
  });

  it('scopes cards per project and swaps with the active tab', () => {
    activateProject('P-1', [{ id: 'T-1' }]);
    activateProject('P-2', [{ id: 'T-9' }]);
    // A live create activates its project (create + activate echoes).
    events.emit(wireEvent('projectActivated', { projectId: 'P-2' }, 'P-2'));
    TestBed.tick();

    expect(service.cards().map((c) => c.id)).toEqual(['T-9']);

    events.emit(wireEvent('projectActivated', { projectId: 'P-1' }, 'P-1'));
    TestBed.tick();
    expect(service.cards().map((c) => c.id)).toEqual(['T-1']);
  });

  describe('requestMove', () => {
    beforeEach(() => {
      activateProject('P-1', [
        { id: 'T-1', stage: WireStage.STAGE_CODING },
        { id: 'T-2', blockedBy: ['T-1'] },
        { id: 'T-3', type: WireCardType.CARD_TYPE_DESIGN },
      ]);
      TestBed.tick();
    });

    it('publishes the move optimistically and keeps it on ok', async () => {
      const promise = service.requestMove('T-1', 'validation');
      // Optimistic: applied synchronously, before the publish resolves.
      expect(service.cardsById().get('T-1')?.stage).toBe('validation');

      expect(await promise).toEqual({ ok: true });
      const command = events.lastCommand('requestCardMove');
      expect(command?.projectId).toBe('P-1');
      expect(command?.requestCardMove).toEqual({
        cardId: 'T-1',
        toLane: WireStage.STAGE_VALIDATION,
        override: false,
        comment: '',
      });
    });

    it('rejects lanes invalid for the card type without publishing', async () => {
      expect(await service.requestMove('T-3', 'security')).toEqual({
        ok: false,
        reason: 'invalid-lane',
      });
      expect(events.lastCommand('requestCardMove')).toBeUndefined();
      expect(service.cardsById().get('T-3')?.stage).toBe('new');
    });

    it('rejects moving a blocked card without publishing', async () => {
      expect(await service.requestMove('T-2', 'coding')).toEqual({ ok: false, reason: 'blocked' });
      expect(events.lastCommand('requestCardMove')).toBeUndefined();
    });

    it('rejects unknown cards', async () => {
      expect(await service.requestMove('T-999', 'coding')).toEqual({
        ok: false,
        reason: 'unknown-card',
      });
    });

    it('treats a move to the current lane as a no-op success', async () => {
      expect(await service.requestMove('T-1', 'coding')).toEqual({ ok: true });
      expect(events.lastCommand('requestCardMove')).toBeUndefined();
    });

    it('reverts the optimistic move on a server rejection', async () => {
      events.respondWith({
        ok: false,
        rejectionCode: WireRejectionCode.REJECTION_CODE_INVALID_LANE,
        rejectionMessage: 'nope',
      });
      const result = await service.requestMove('T-1', 'review');
      expect(result).toEqual({ ok: false, reason: 'invalid-lane' });
      expect(service.cardsById().get('T-1')?.stage).toBe('coding');
    });

    it('unblocks a card once its blockers reach done', async () => {
      for (const lane of ['validation', 'review', 'security', 'approval', 'done'] as const) {
        expect((await service.requestMove('T-1', lane)).ok).toBe(true);
        emitCardMoved('T-1', stageToWire(lane));
        TestBed.tick();
      }
      expect(service.blockedIds().has('T-2')).toBe(false);
      expect(await service.requestMove('T-2', 'coding')).toEqual({ ok: true });
    });
  });

  describe('event reconciliation', () => {
    beforeEach(() => {
      activateProject('P-1', [
        { id: 'T-1', stage: WireStage.STAGE_CODING, assignee: { role: 'coder', model: 'm', effort: 'e' } },
      ]);
      TestBed.tick();
    });

    it('folds CardMoved: stage, unassign on new, rejection comment', () => {
      emitCardMoved('T-1', WireStage.STAGE_NEW);
      TestBed.tick();

      const card = service.cardsById().get('T-1')!;
      expect(card.stage).toBe('new');
      expect(card.assignee).toBeUndefined();

      activateProject('P-1', []);
      emitCardMoved('T-1', WireStage.STAGE_CODING, 'needs work');
      TestBed.tick();
      expect(service.cardsById().get('T-1')?.rejectionComment).toBe('needs work');
    });

    it('folds CardTypeChanged: type, reset sub-state, lane fallback', () => {
      emitCardMoved('T-1', WireStage.STAGE_SECURITY);
      TestBed.tick();
      events.emit(
        wireEvent(
          'cardTypeChanged',
          { cardId: 'T-1', from: WireCardType.CARD_TYPE_CODING, to: WireCardType.CARD_TYPE_DESIGN },
          'P-1',
        ),
      );
      TestBed.tick();

      const card = service.cardsById().get('T-1')!;
      expect(card.type).toBe('design');
      expect(card.stage).toBe('new'); // security is not a design lane
      expect(card.checklist().map((e) => e.stage)).toEqual([
        'draft',
        'implement',
        'runValidation',
        'reviewChanges',
        'humanReview',
      ]);
    });

    it('folds SubStateUpdated into the checklist', () => {
      events.emit(
        wireEvent(
          'subStateUpdated',
          { cardId: 'T-1', stage: 'implement', status: WireSubStateStatus.SUB_STATE_STATUS_RUNNING },
          'P-1',
        ),
      );
      TestBed.tick();
      expect(service.cardsById().get('T-1')?.subState['implement']).toBe('running');
    });

    it('folds CardsCommitted as new cards', () => {
      events.emit(
        wireEvent(
          'cardsCommitted',
          { cards: [wireCard({ id: 'T-7' }), wireCard({ id: 'T-8', blockedBy: ['T-7'] })] },
          'P-1',
        ),
      );
      TestBed.tick();
      expect(service.cardsById().has('T-7')).toBe(true);
      expect(service.blockedIds().has('T-8')).toBe(true);
    });

    it('folds CardArchived and closes the panel', () => {
      service.openCard('T-1');
      events.emit(wireEvent('cardArchived', { cardId: 'T-1' }, 'P-1'));
      TestBed.tick();
      expect(service.cardsById().has('T-1')).toBe(false);
      expect(service.selectedCard()).toBeNull();
    });
  });

  describe('forceMove', () => {
    it('publishes with override and still enforces type-valid lanes', async () => {
      activateProject('P-1', [
        { id: 'T-1', stage: WireStage.STAGE_CODING },
        { id: 'T-2', type: WireCardType.CARD_TYPE_DESIGN, blockedBy: ['T-1'] },
      ]);
      TestBed.tick();

      expect(await service.forceMove('T-2', 'design')).toEqual({ ok: true });
      expect(events.lastCommand('requestCardMove')?.requestCardMove?.override).toBe(true);
      expect(await service.forceMove('T-2', 'security')).toEqual({
        ok: false,
        reason: 'invalid-lane',
      });
    });
  });

  describe('automation toggles', () => {
    it('starts with every agent-owned lane on', () => {
      expect(service.automation().onCount).toBe(Lane.AGENT_OWNED.size);
      expect(service.automation().isOn('coding')).toBe(true);
    });

    it('publishes the flipped state and folds the echo', async () => {
      const promise = service.toggleAutomation('security');
      expect(service.automation().isOn('security')).toBe(false);
      await promise;

      const command = events.lastCommand('requestAutomationToggle');
      expect(command?.requestAutomationToggle).toEqual({
        lane: WireStage.STAGE_SECURITY,
        on: false,
      });

      events.emit(
        wireEvent('automationToggled', { lane: WireStage.STAGE_SECURITY, on: false }, 'P-1'),
      );
      TestBed.tick();
      expect(service.automation().isOn('security')).toBe(false);
      expect(service.automation().onCount).toBe(Lane.AGENT_OWNED.size - 1);
    });

    it('treats an omitted `on` as false (canonical JSON drops defaults)', () => {
      // The wire shape as actually emitted by DomainEvent.toJSON for on=false.
      events.emit(wireEvent('automationToggled', { lane: WireStage.STAGE_REVIEW }, 'P-1'));
      TestBed.tick();
      expect(service.automation().isOn('review')).toBe(false);
    });

    it('reverts on rejection', async () => {
      events.respondWith({ ok: false, rejectionMessage: 'down' });
      await service.toggleAutomation('review');
      expect(service.automation().isOn('review')).toBe(true);
    });

    it('ignores lanes that are not agent-owned', async () => {
      const before = service.automation();
      await service.toggleAutomation('new');
      await service.toggleAutomation('approval');
      expect(service.automation()).toBe(before);
      expect(events.lastCommand('requestAutomationToggle')).toBeUndefined();
    });
  });

  describe('changeType', () => {
    it('publishes the change and applies it optimistically', async () => {
      activateProject('P-1', [{ id: 'T-1', stage: WireStage.STAGE_REVIEW }]);
      TestBed.tick();

      const promise = service.changeType('T-1', 'docs');
      const optimistic = service.cardsById().get('T-1')!;
      expect(optimistic.type).toBe('docs');
      expect(optimistic.stage).toBe('review'); // review is valid for docs
      expect(optimistic.checklist().every((e) => e.status === 'pending')).toBe(true);
      expect(await promise).toEqual({ ok: true });
      expect(events.lastCommand('requestCardTypeChange')?.requestCardTypeChange).toEqual({
        cardId: 'T-1',
        toType: WireCardType.CARD_TYPE_DOCS,
      });
    });

    it('is a no-op for the same type and rejects unknown cards', async () => {
      activateProject('P-1', [{ id: 'T-1' }]);
      TestBed.tick();
      expect(await service.changeType('T-1', 'coding')).toEqual({ ok: true });
      expect(events.lastCommand('requestCardTypeChange')).toBeUndefined();
      expect(await service.changeType('T-999', 'docs')).toEqual({
        ok: false,
        reason: 'unknown-card',
      });
    });
  });

  describe('selection and assignment', () => {
    beforeEach(() => {
      activateProject('P-1', [{ id: 'T-1' }]);
      TestBed.tick();
    });

    it('opens and closes the card panel', () => {
      expect(service.selectedCard()).toBeNull();
      service.openCard('T-1');
      expect(service.selectedCard()?.id).toBe('T-1');
      service.closeCard();
      expect(service.selectedCard()).toBeNull();
    });

    it('assignToMe sets the human assignee locally and unassign clears it', () => {
      service.assignToMe('T-1');
      expect(service.cardsById().get('T-1')?.assignee?.isHuman).toBe(true);
      service.unassign('T-1');
      expect(service.cardsById().get('T-1')?.assignee).toBeUndefined();
      // Local-only: nothing published.
      expect(events.published).toEqual([]);
    });
  });

  describe('archive', () => {
    it('publishes the archive and restores on rejection', async () => {
      activateProject('P-1', [{ id: 'T-1' }]);
      TestBed.tick();

      await service.archive('T-1');
      expect(service.cardsById().has('T-1')).toBe(false);
      expect(events.lastCommand('requestCardArchive')?.requestCardArchive).toEqual({
        cardId: 'T-1',
      });

      activateProject('P-1', [{ id: 'T-2' }]);
      TestBed.tick();
      events.respondWith({ ok: false, rejectionMessage: 'down' });
      await service.archive('T-2');
      expect(service.cardsById().has('T-2')).toBe(true);
    });
  });

  describe('rejection comment', () => {
    beforeEach(() => {
      activateProject('P-1', [{ id: 'T-1', stage: WireStage.STAGE_APPROVAL }]);
      TestBed.tick();
    });

    it('opens the prompt on an approval -> implement-lane drag and defers the publish', async () => {
      expect(await service.requestMove('T-1', 'coding')).toEqual({ ok: true });
      expect(service.rejectionPrompt()).toEqual({ cardId: 'T-1' });
      expect(service.cardsById().get('T-1')?.stage).toBe('coding');
      expect(events.lastCommand('requestCardMove')).toBeUndefined();
    });

    it('publishes the move with the comment once recorded', async () => {
      await service.requestMove('T-1', 'coding');
      service.recordRejectionComment('  needs more tests  ');

      expect(service.rejectionPrompt()).toBeNull();
      expect(service.cardsById().get('T-1')?.rejectionComment).toBe('needs more tests');
      await Promise.resolve();
      expect(events.lastCommand('requestCardMove')?.requestCardMove).toEqual({
        cardId: 'T-1',
        toLane: WireStage.STAGE_CODING,
        override: false,
        comment: 'needs more tests',
      });
    });

    it('publishes without a comment when dismissed', async () => {
      await service.requestMove('T-1', 'coding');
      service.dismissRejectionPrompt();
      await Promise.resolve();
      expect(events.lastCommand('requestCardMove')?.requestCardMove?.comment).toBe('');
    });

    it('reverts to approval when the deferred move is rejected', async () => {
      await service.requestMove('T-1', 'coding');
      events.respondWith({ ok: false, rejectionMessage: 'down' });
      service.recordRejectionComment('why');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(service.cardsById().get('T-1')?.stage).toBe('approval');
    });

    it('does not open the prompt for other moves out of approval', async () => {
      expect(await service.requestMove('T-1', 'done')).toEqual({ ok: true });
      expect(service.rejectionPrompt()).toBeNull();
    });
  });
});
