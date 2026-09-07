import { TestBed } from '@angular/core/testing';

import {
  FakeEventsClient,
  provideFakeEventsClient,
  wireCard,
  wireEvent,
} from '../core/events/events-client.fake';
import { WireCardType, WireRejectionCode, WireStepStateStatus } from '../core/events/wire';
import { BoardService } from './board.service';

/**
 * BoardService over the event stream: wire events fold into the same signals
 * the fixtures seed; commands publish optimistically and revert on a typed
 * rejection. Phase 10: stage moves, run locks, and pipeline assignment.
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

  /** Fold a project, its default pipeline, and any cards, like a snapshot. */
  function activateProject(projectId: string, cards: Parameters<typeof wireCard>[0][] = []) {
    events.emit(
      wireEvent(
        'projectCreated',
        { project: { id: projectId, name: projectId, createdAt: new Date().toISOString() } },
        projectId,
      ),
    );
    seedPipeline(projectId);
    for (const card of cards) {
      events.emit(wireEvent('cardCreated', { card: wireCard({ projectId, ...card }) }, projectId));
    }
  }

  function seedPipeline(projectId = 'P-1') {
    events.emit(
      wireEvent(
        'pipelineSaved',
        {
          pipeline: {
            id: 'PL-1',
            projectId,
            name: 'Standard coding card',
            revision: 1,
            updatedAt: new Date().toISOString(),
            stages: [
              { id: 'sg-1', label: 'New', kanbanVisible: true },
              { id: 'sg-2', label: 'Implementation', kanbanVisible: true },
              { id: 'sg-3', label: 'Validation', kanbanVisible: true },
              { id: 'sg-4', label: 'Approval', kanbanVisible: true },
              { id: 'sg-5', label: 'Done', kanbanVisible: true, terminal: true },
            ],
            steps: [
              { id: 'st-1', kind: 'agent', stageId: 'sg-2', agentKind: 'coder', instructions: 'Implement.' },
              { id: 'st-2', kind: 'command', stageId: 'sg-3', command: 'npm test', description: 'Tests' },
            ],
          },
        },
        projectId,
      ),
    );
  }

  function seedRun(cardId: string, projectId = 'P-1') {
    events.emit(
      wireEvent(
        'pipelineRunStarted',
        { runId: 'R-1', cardId, pipelineId: 'PL-1', revision: 1 },
        projectId,
      ),
    );
  }

  function endRun(cardId: string, projectId = 'P-1') {
    events.emit(
      wireEvent(
        'pipelineRunEnded',
        { runId: 'R-1', cardId, pipelineId: 'PL-1', revision: 1, status: 'cancelled' },
        projectId,
      ),
    );
  }

  function emitStageMove(cardId: string, toStageId: string, comment = '', projectId = 'P-1') {
    events.emit(
      wireEvent('cardStageMoved', { cardId, pipelineId: 'PL-1', toStageId, comment }, projectId),
    );
  }

  it('folds CardCreated into the board and derives blocked cards', () => {
    activateProject('P-1', [
      { id: 'T-1', stageId: 'sg-2' },
      { id: 'T-2', blockedBy: ['T-1'] },
    ]);
    TestBed.tick();

    expect(service.cards().map((c) => c.id)).toEqual(['T-1', 'T-2']);
    expect(service.blockedIds().has('T-2')).toBe(true);
    expect(service.blockedIds().has('T-1')).toBe(false);
  });

  it('unblocks a card once its blocker reaches the terminal stage', () => {
    activateProject('P-1', [
      { id: 'T-1', stageId: 'sg-2' },
      { id: 'T-2', blockedBy: ['T-1'] },
    ]);
    TestBed.tick();
    expect(service.blockedIds().has('T-2')).toBe(true);

    emitStageMove('T-1', 'sg-5');
    TestBed.tick();
    expect(service.blockedIds().has('T-2')).toBe(false);
    expect(service.cardsById().get('T-1')?.stageId).toBe('sg-5');
  });

  it('scopes cards per project and swaps with the active tab', () => {
    activateProject('P-1', [{ id: 'T-1' }]);
    activateProject('P-2', [{ id: 'T-9' }]);
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
        { id: 'T-1', stageId: 'sg-2' },
        { id: 'T-2', blockedBy: ['T-1'] },
      ]);
      TestBed.tick();
    });

    it('publishes the stage move optimistically and keeps it on ok', async () => {
      const promise = service.requestMove('T-1', 'sg-3');
      // Optimistic: applied synchronously, before the publish resolves.
      expect(service.cardsById().get('T-1')?.stageId).toBe('sg-3');

      expect(await promise).toEqual({ ok: true });
      const command = events.lastCommand('requestCardStageMove');
      expect(command?.projectId).toBe('P-1');
      expect(command?.requestCardStageMove).toEqual({
        cardId: 'T-1',
        toStageId: 'sg-3',
        override: false,
        comment: '',
      });
    });

    it('rejects stages that are not in the assigned pipeline', async () => {
      expect(await service.requestMove('T-1', 'sg-99')).toEqual({
        ok: false,
        reason: 'unknown-stage',
      });
      expect(events.lastCommand('requestCardStageMove')).toBeUndefined();
      expect(service.cardsById().get('T-1')?.stageId).toBe('sg-2');
    });

    it('rejects moving a blocked card without publishing', async () => {
      expect(await service.requestMove('T-2', 'sg-2')).toEqual({ ok: false, reason: 'blocked' });
      expect(events.lastCommand('requestCardStageMove')).toBeUndefined();
    });

    it('rejects unknown cards', async () => {
      expect(await service.requestMove('T-999', 'sg-2')).toEqual({
        ok: false,
        reason: 'unknown-card',
      });
    });

    it('rejects while a run is active and allows it again after the run ends', async () => {
      seedRun('T-1');
      TestBed.tick();
      expect(await service.requestMove('T-1', 'sg-3')).toEqual({
        ok: false,
        reason: 'run-active',
      });
      expect(events.lastCommand('requestCardStageMove')).toBeUndefined();

      endRun('T-1');
      TestBed.tick();
      expect(await service.requestMove('T-1', 'sg-3')).toEqual({ ok: true });
    });

    it('treats a move to the current stage as a no-op success', async () => {
      expect(await service.requestMove('T-1', 'sg-2')).toEqual({ ok: true });
      expect(events.lastCommand('requestCardStageMove')).toBeUndefined();
    });

    it('reverts the optimistic move on a server rejection', async () => {
      events.respondWith({
        ok: false,
        rejectionCode: WireRejectionCode.REJECTION_CODE_UNKNOWN_STAGE,
        rejectionMessage: 'nope',
      });
      const result = await service.requestMove('T-1', 'sg-4');
      expect(result).toEqual({ ok: false, reason: 'unknown-stage' });
      expect(service.cardsById().get('T-1')?.stageId).toBe('sg-2');
    });
  });

  describe('forceMove', () => {
    it('publishes with override and bypasses blockers', async () => {
      activateProject('P-1', [
        { id: 'T-1', stageId: 'sg-2' },
        { id: 'T-2', blockedBy: ['T-1'] },
      ]);
      TestBed.tick();

      expect(await service.forceMove('T-2', 'sg-3')).toEqual({ ok: true });
      expect(events.lastCommand('requestCardStageMove')?.requestCardStageMove?.override).toBe(true);
      expect(await service.forceMove('T-2', 'sg-99')).toEqual({
        ok: false,
        reason: 'unknown-stage',
      });
    });
  });

  describe('event reconciliation', () => {
    beforeEach(() => {
      activateProject('P-1', [
        {
          id: 'T-1',
          stageId: 'sg-2',
          assignee: { role: 'coder', model: 'm', effort: 'e' },
        },
      ]);
      TestBed.tick();
    });

    it('folds CardStageMoved: the stage and the rejection comment', () => {
      emitStageMove('T-1', 'sg-3');
      TestBed.tick();
      expect(service.cardsById().get('T-1')?.stageId).toBe('sg-3');

      emitStageMove('T-1', 'sg-2', 'needs work');
      TestBed.tick();
      expect(service.cardsById().get('T-1')?.rejectionComment).toBe('needs work');
    });

    it('folds CardPipelineAssigned: pipeline and first stage', () => {
      events.emit(
        wireEvent(
          'cardPipelineAssigned',
          { cardId: 'T-1', pipelineId: 'PL-2', stageId: 'd-1' },
          'P-1',
        ),
      );
      TestBed.tick();
      const card = service.cardsById().get('T-1')!;
      expect(card.pipelineId).toBe('PL-2');
      expect(card.stageId).toBe('d-1');
    });

    it('folds CardTypeChanged: type and reset step states, stage untouched', () => {
      events.emit(
        wireEvent(
          'cardStepStateUpdated',
          { cardId: 'T-1', stepId: 'st-1', status: WireStepStateStatus.STEP_STATE_OK },
          'P-1',
        ),
      );
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
      expect(card.stageId).toBe('sg-2');
      expect(card.stepStates).toEqual({});
    });

    it('folds CardStepStateUpdated into the step states', () => {
      events.emit(
        wireEvent(
          'cardStepStateUpdated',
          { cardId: 'T-1', stepId: 'st-1', status: WireStepStateStatus.STEP_STATE_RUNNING },
          'P-1',
        ),
      );
      TestBed.tick();
      expect(service.cardsById().get('T-1')?.stepStates['st-1']).toBe('running');
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

  describe('automation toggles', () => {
    it('publishes the flipped state keyed per pipeline stage and folds the echo', async () => {
      const promise = service.toggleAutomation('PL-1', 'sg-2');
      expect(service.automation().isOn('PL-1', 'sg-2')).toBe(true);
      await promise;

      const command = events.lastCommand('requestAutomationToggle');
      expect(command?.requestAutomationToggle).toEqual({
        pipelineId: 'PL-1',
        stageId: 'sg-2',
        on: true,
      });

      events.emit(
        wireEvent('automationToggled', { pipelineId: 'PL-1', stageId: 'sg-2', on: false }, 'P-1'),
      );
      TestBed.tick();
      expect(service.automation().isOn('PL-1', 'sg-2')).toBe(false);
      // Another stage of the same pipeline is unaffected.
      expect(service.automation().isOn('PL-1', 'sg-3')).toBe(false);
    });

    it('treats an omitted `on` as false (canonical JSON drops defaults)', () => {
      events.emit(wireEvent('automationToggled', { pipelineId: 'PL-1', stageId: 'sg-3' }, 'P-1'));
      TestBed.tick();
      expect(service.automation().isOn('PL-1', 'sg-3')).toBe(false);
    });

    it('reverts on rejection', async () => {
      events.respondWith({ ok: false, rejectionMessage: 'down' });
      await service.toggleAutomation('PL-1', 'sg-3');
      expect(service.automation().isOn('PL-1', 'sg-3')).toBe(false);
    });
  });

  describe('changeType', () => {
    it('publishes the change and resets the step states optimistically', async () => {
      activateProject('P-1', [{ id: 'T-1', stageId: 'sg-2', stepStates: { 'st-1': 'ok' } }]);
      TestBed.tick();

      const promise = service.changeType('T-1', 'docs');
      const optimistic = service.cardsById().get('T-1')!;
      expect(optimistic.type).toBe('docs');
      expect(optimistic.stageId).toBe('sg-2');
      expect(optimistic.stepStates).toEqual({});
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

  describe('pipeline assignment and reopen', () => {
    beforeEach(() => {
      activateProject('P-1', [{ id: 'T-1', stageId: 'sg-3' }]);
      TestBed.tick();
    });

    it('assignPipeline publishes and places the card in the first stage', async () => {
      events.emit(
        wireEvent(
          'pipelineSaved',
          {
            pipeline: {
              id: 'PL-2',
              projectId: 'P-1',
              name: 'Docs pass',
              revision: 1,
              updatedAt: new Date().toISOString(),
              stages: [
                { id: 'd-1', label: 'Draft', kanbanVisible: true },
                { id: 'd-2', label: 'Done', kanbanVisible: true, terminal: true },
              ],
              steps: [{ id: 'ds-1', kind: 'agent', stageId: 'd-1', agentKind: 'coder', instructions: 'Write.' }],
            },
          },
          'P-1',
        ),
      );
      TestBed.tick();

      const promise = service.assignPipeline('T-1', 'PL-2');
      const optimistic = service.cardsById().get('T-1')!;
      expect(optimistic.pipelineId).toBe('PL-2');
      expect(optimistic.stageId).toBe('d-1');
      expect(await promise).toEqual({ ok: true });
      expect(events.lastCommand('requestCardPipelineAssign')?.requestCardPipelineAssign).toEqual({
        cardId: 'T-1',
        pipelineId: 'PL-2',
      });
    });

    it('assignPipeline reverts on a rejection', async () => {
      events.emit(
        wireEvent(
          'pipelineSaved',
          {
            pipeline: {
              id: 'PL-2',
              projectId: 'P-1',
              name: 'Docs pass',
              revision: 1,
              updatedAt: new Date().toISOString(),
              stages: [
                { id: 'd-1', label: 'Draft', kanbanVisible: true },
                { id: 'd-2', label: 'Done', kanbanVisible: true, terminal: true },
              ],
              steps: [{ id: 'ds-1', kind: 'agent', stageId: 'd-1', agentKind: 'coder', instructions: 'Write.' }],
            },
          },
          'P-1',
        ),
      );
      TestBed.tick();
      events.respondWith({
        ok: false,
        rejectionCode: WireRejectionCode.REJECTION_CODE_RUN_ACTIVE,
        rejectionMessage: 'busy',
      });
      const result = await service.assignPipeline('T-1', 'PL-2');
      expect(result).toEqual({ ok: false, reason: 'run-active' });
      expect(service.cardsById().get('T-1')?.pipelineId).toBe('PL-1');
    });

    it('reopen publishes requestCardReopen and moves to the first stage', async () => {
      emitStageMove('T-1', 'sg-5');
      TestBed.tick();

      const promise = service.reopen('T-1');
      expect(service.cardsById().get('T-1')?.stageId).toBe('sg-1');
      expect(await promise).toEqual({ ok: true });
      expect(events.lastCommand('requestCardReopen')?.requestCardReopen).toEqual({ cardId: 'T-1' });
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

    it('assignToMe publishes requestCardAssign and folds the echo', async () => {
      await service.assignToMe('T-1');
      expect(service.cardsById().get('T-1')?.assignee?.isHuman).toBe(true);
      expect(events.lastCommand('requestCardAssign')).toMatchObject({
        projectId: 'P-1',
        requestCardAssign: { cardId: 'T-1', assignee: { role: 'human' } },
      });

      await service.unassign('T-1');
      expect(service.cardsById().get('T-1')?.assignee).toBeUndefined();
      expect('assignee' in events.lastCommand('requestCardAssign')!.requestCardAssign!).toBe(false);
    });

    it('folds cardAssigned events from other writers', async () => {
      events.emit(
        wireEvent('cardAssigned', { cardId: 'T-1', assignee: { role: 'coder', model: 'm', effort: 'high' } }),
      );
      TestBed.tick();
      const assignee = service.cardsById().get('T-1')?.assignee;
      expect(assignee?.isHuman).toBe(false);
      expect(assignee?.label).toContain('m · high');

      events.emit(wireEvent('cardAssigned', { cardId: 'T-1' }));
      TestBed.tick();
      expect(service.cardsById().get('T-1')?.assignee).toBeUndefined();
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
      activateProject('P-1', [{ id: 'T-1', stageId: 'sg-5' }]);
      TestBed.tick();
    });

    it('opens the prompt on a drag out of the terminal stage and defers the publish', async () => {
      expect(await service.requestMove('T-1', 'sg-2')).toEqual({ ok: true });
      expect(service.rejectionPrompt()).toEqual({ cardId: 'T-1' });
      expect(service.cardsById().get('T-1')?.stageId).toBe('sg-2');
      expect(events.lastCommand('requestCardStageMove')).toBeUndefined();
    });

    it('publishes the move with the comment once recorded', async () => {
      await service.requestMove('T-1', 'sg-2');
      service.recordRejectionComment('  needs more tests  ');

      expect(service.rejectionPrompt()).toBeNull();
      expect(service.cardsById().get('T-1')?.rejectionComment).toBe('needs more tests');
      await Promise.resolve();
      expect(events.lastCommand('requestCardStageMove')?.requestCardStageMove).toEqual({
        cardId: 'T-1',
        toStageId: 'sg-2',
        override: false,
        comment: 'needs more tests',
      });
    });

    it('publishes without a comment when dismissed', async () => {
      await service.requestMove('T-1', 'sg-2');
      service.dismissRejectionPrompt();
      await Promise.resolve();
      expect(events.lastCommand('requestCardStageMove')?.requestCardStageMove?.comment).toBe('');
    });

    it('reverts to the terminal stage when the deferred move is rejected', async () => {
      await service.requestMove('T-1', 'sg-2');
      events.respondWith({ ok: false, rejectionMessage: 'down' });
      service.recordRejectionComment('why');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(service.cardsById().get('T-1')?.stageId).toBe('sg-5');
    });

    it('does not open the prompt for moves into the terminal stage', async () => {
      activateProject('P-1', [{ id: 'T-2', stageId: 'sg-4' }]);
      TestBed.tick();
      expect(await service.requestMove('T-2', 'sg-5')).toEqual({ ok: true });
      expect(service.rejectionPrompt()).toBeNull();
    });
  });
});
