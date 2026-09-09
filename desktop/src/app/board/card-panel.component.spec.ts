import { TestBed } from '@angular/core/testing';

import {
  FakeEventsClient,
  provideFakeEventsClient,
  seedCard,
  seedProject,
  wireEvent,
} from '../core/events/events-client.fake';
import {
  WireCardType,
  WirePipelineRunStatus,
  WirePipelineStepKind,
  WireStepStateStatus,
} from '../core/events/wire';
import { Card } from '../core/models/board.models';
import { PipelineService } from '../pipelines/pipeline.service';
import { BoardService } from './board.service';
import { CardPanelComponent } from './card-panel.component';

describe('CardPanelComponent', () => {
  let service: BoardService;
  let events: FakeEventsClient;

  beforeEach(async () => {
    events = new FakeEventsClient();
    await TestBed.configureTestingModule({
      imports: [CardPanelComponent],
      providers: [provideFakeEventsClient(events)],
    }).compileComponents();
    service = TestBed.inject(BoardService);
    TestBed.inject(PipelineService);
    seedProject(events, 'P-1');
    seedDefaultPipeline();
    seedCards();
  });

  function seedDefaultPipeline(): void {
    events.emit(
      wireEvent('pipelineSaved', {
        pipeline: {
          id: 'PL-1',
          projectId: 'P-1',
          name: 'Standard coding card',
          revision: 1,
          updatedAt: '',
          steps: [
            { id: 'st-1', kind: WirePipelineStepKind.PIPELINE_STEP_KIND_AGENT, boardVisible: true, agentKind: 'coder', instructions: 'Implement the card.' },
            { id: 'st-2', kind: WirePipelineStepKind.PIPELINE_STEP_KIND_COMMAND, boardVisible: false, command: 'npm test', description: 'Run tests' },
            { id: 'st-3', kind: WirePipelineStepKind.PIPELINE_STEP_KIND_HUMAN, boardVisible: true, description: 'Approval' },
            { id: 'st-4', kind: WirePipelineStepKind.PIPELINE_STEP_KIND_HUMAN, boardVisible: true, terminal: true },
          ],
        },
      }),
    );
  }

  function seedCards(): void {
    seedCard(events, {
      id: 'T-148',
      title: 'Diff overlay: syntax highlighting',
      description: 'Wire shiki, cache per language, lazy-load grammars.',
      stepId: 'st-2',
      assignee: { role: 'coder', model: 'gpt-5.4', effort: 'medium' },
    });
    seedCard(events, {
      id: 'T-141',
      stepId: 'st-3',
      stepStates: {
        'st-1': WireStepStateStatus.STEP_STATE_OK,
        'st-2': WireStepStateStatus.STEP_STATE_RUNNING,
      },
    });
    seedCard(events, {
      id: 'T-146',
      type: WireCardType.CARD_TYPE_DESIGN,
      stepId: 'st-2',
    });
    seedCard(events, { id: 'T-139', stepId: 'st-3' });
    seedCard(events, { id: 'T-152', blockedBy: ['T-148'] });
    seedCard(events, { id: 'T-150', type: WireCardType.CARD_TYPE_DESIGN, stepId: 'st-2' });
    seedCard(events, { id: 'T-131', stepId: 'st-3' });
  }

  async function render(cardId: string) {
    const card = service.cardsById().get(cardId)!;
    const fixture = TestBed.createComponent(CardPanelComponent);
    fixture.componentRef.setInput('card', card);
    await fixture.whenStable();
    return fixture;
  }

  function el(fixture: Awaited<ReturnType<typeof render>>): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  async function cardOf(
    fixture: Awaited<ReturnType<typeof render>>,
    id: string,
  ): Promise<Card> {
    const card = service.cardsById().get(id)!;
    fixture.componentRef.setInput('card', card);
    await fixture.whenStable();
    return card;
  }

  it('renders id, title, description and age', async () => {
    const fixture = await render('T-148');
    const text = el(fixture).textContent!;
    expect(text).toContain('T-148');
    expect(text).toContain('Diff overlay: syntax highlighting');
    expect(text).toContain('Wire shiki, cache per language, lazy-load grammars.');
  });

  it('renders the assigned pipeline\'s steps with their execution state', async () => {
    const fixture = await render('T-141');
    const rows = [...el(fixture).querySelectorAll('.check-row')];
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.querySelector('.check-label')!.textContent!.trim())).toEqual([
      'Implement the card.',
      'Run tests',
      'Approval',
    ]);
    expect(rows[0].classList).toContain('ok');
    expect(rows[1].classList).toContain('running');
    expect(rows[2].classList).toContain('pending');
  });

  it('changes the card type from the picker and resets the step states', async () => {
    const fixture = await render('T-139');
    const options = [...el(fixture).querySelectorAll<HTMLButtonElement>('.type-option')];
    const docs = options.find((o) => o.textContent!.includes('docs'))!;
    docs.click();
    await fixture.whenStable();

    const changed = await cardOf(fixture, 'T-139');
    expect(changed.type).toBe('docs');
    expect(changed.stepStates).toEqual({});
    // The stage is pipeline-local; the type change does not move it.
    expect(changed.stepId).toBe('st-3');
  });

  it('lists blockers and blocking cards as clickable chips', async () => {
    // T-152 is blocked by T-148; T-148 blocks T-152.
    const fixture = await render('T-152');
    const blockerChips = [...el(fixture).querySelectorAll('.dep-row:first-of-type .dep-chip')];
    expect(blockerChips.length).toBe(1);
    expect(blockerChips[0].textContent).toContain('T-148');

    (blockerChips[0] as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(service.selectedCard()?.id).toBe('T-148');

    const inverse = await render('T-148');
    const blockingChips = [...el(inverse).querySelectorAll('.dep-chip')];
    expect(blockingChips.some((c) => c.textContent!.includes('T-152'))).toBe(true);
  });

  it('assigns to me and unassigns from the footer', async () => {
    const fixture = await render('T-150');
    const actions = [...el(fixture).querySelectorAll<HTMLButtonElement>('.actions .action')];
    const assignToMe = actions.find((b) => b.textContent!.includes('assign to me'))!;
    assignToMe.click();
    await fixture.whenStable();
    expect((await cardOf(fixture, 'T-150')).assignee?.isHuman).toBe(true);

    const unassign = [...el(fixture).querySelectorAll<HTMLButtonElement>('.actions .action')].find(
      (b) => b.textContent!.includes('unassign'),
    )!;
    unassign.click();
    await fixture.whenStable();
    expect(service.cardsById().get('T-150')?.assignee).toBeUndefined();
  });

  it('force-moves via the stage select', async () => {
    const fixture = await render('T-150');
    const select = el(fixture).querySelector<HTMLSelectElement>('.force-move select')!;
    select.value = 'st-4';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(service.cardsById().get('T-150')?.stepId).toBe('st-4');
  });

  it('archives the card and closes the panel', async () => {
    service.openCard('T-150');
    const fixture = await render('T-150');
    const archive = [...el(fixture).querySelectorAll<HTMLButtonElement>('.action')].find((b) =>
      b.textContent!.includes('archive'),
    )!;
    archive.click();
    await fixture.whenStable();
    expect(service.cardsById().has('T-150')).toBe(false);
    expect(service.selectedCard()).toBeNull();
  });

  it('closes on Escape', async () => {
    service.openCard('T-148');
    const fixture = await render('T-148');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await fixture.whenStable();
    expect(service.selectedCard()).toBeNull();
  });

  it('shows the rejection comment when present', async () => {
    // T-131 sits at Approval; complete it, then drag it back (the
    // rejection flow) and record the comment.
    events.emit(
      wireEvent('cardStepMoved', { cardId: 'T-131', pipelineId: 'PL-1', toStepId: 'st-4' }),
    );
    TestBed.tick();
    await service.requestMove('T-131', 'st-2');
    service.recordRejectionComment('needs more tests');
    const fixture = await render('T-131');
    expect(el(fixture).querySelector('.rejection')?.textContent).toContain('needs more tests');
  });

  it('shows the run with the gate affordance and answers it', async () => {
    // The pipeline waiting at its gate on T-148.
    events.emit(
      wireEvent('pipelineRunStarted', { runId: 'R-1', cardId: 'T-148', pipelineId: 'PL-1', revision: 1 }),
    );
    events.emit(
      wireEvent('pipelineStepStarted', {
        runId: 'R-1',
        cardId: 'T-148',
        pipelineId: 'PL-1',
        stepId: 'st-3',
        kind: WirePipelineStepKind.PIPELINE_STEP_KIND_HUMAN,
      }),
    );

    const fixture = await render('T-148');
    const view = el(fixture);
    expect(view.querySelector('.run-progress')?.classList).toContain('waiting');
    expect(view.textContent).toContain('waiting at the gate');

    // Approving publishes the gate response with the comment.
    const comment = view.querySelector<HTMLInputElement>('.gate-comment')!;
    comment.value = 'ship it';
    comment.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    view.querySelector<HTMLButtonElement>('.gate-approve')!.click();
    await fixture.whenStable();

    expect(events.lastCommand('requestPipelineGateRespond')).toMatchObject({
      requestPipelineGateRespond: { cardId: 'T-148', approved: true, comment: 'ship it' },
    });
  });

  it('offers run and stop for the card', async () => {
    const fixture = await render('T-148');
    const view = el(fixture);
    // No run yet: the start affordance runs the card's own pipeline.
    expect(view.querySelector('.run-progress')).toBeNull();
    view.querySelector<HTMLButtonElement>('.run-button')!.click();
    await fixture.whenStable();
    expect(events.lastCommand('requestPipelineRun')).toMatchObject({
      requestPipelineRun: { cardId: 'T-148' },
    });
    expect(events.lastCommand('requestPipelineRun')?.requestPipelineRun).not.toHaveProperty('pipelineId');

    // Once running: the stop affordance replaces the start affordance.
    events.emit(
      wireEvent('pipelineRunStarted', { runId: 'R-1', cardId: 'T-148', pipelineId: 'PL-1', revision: 1 }),
    );
    events.emit(
      wireEvent('pipelineStepStarted', {
        runId: 'R-1',
        cardId: 'T-148',
        pipelineId: 'PL-1',
        stepId: 'st-1',
        kind: WirePipelineStepKind.PIPELINE_STEP_KIND_AGENT,
      }),
    );
    const running = await render('T-148');
    const runningView = el(running);
    expect(runningView.querySelector('.run-progress')?.classList).not.toContain('waiting');
    runningView.querySelector<HTMLButtonElement>('.run-stop')!.click();
    await running.whenStable();
    expect(events.lastCommand('requestPipelineStop')).toMatchObject({
      requestPipelineStop: { cardId: 'T-148' },
    });
  });

  it('disables the run and offers reopen once the card is completed', async () => {
    events.emit(
      wireEvent('cardStepMoved', { cardId: 'T-148', pipelineId: 'PL-1', toStepId: 'st-4' }),
    );
    const fixture = await render('T-148');
    const view = el(fixture);
    const run = view.querySelector<HTMLButtonElement>('.run-button')!;
    expect(run.disabled).toBe(true);

    view.querySelector<HTMLButtonElement>('.reopen-button')!.click();
    await fixture.whenStable();
    expect(events.lastCommand('requestCardReopen')).toMatchObject({
      requestCardReopen: { cardId: 'T-148' },
    });
  });

  it('reassigns the card to another pipeline from the select', async () => {
    events.emit(
      wireEvent('pipelineSaved', {
        pipeline: {
          id: 'PL-2',
          projectId: 'P-1',
          name: 'Docs pass',
          revision: 1,
          updatedAt: '',
          steps: [
            { id: 'd-1', kind: WirePipelineStepKind.PIPELINE_STEP_KIND_AGENT, boardVisible: true, agentKind: 'coder', instructions: 'Write.' },
            { id: 'd-2', kind: WirePipelineStepKind.PIPELINE_STEP_KIND_HUMAN, boardVisible: true, terminal: true },
          ],
        },
      }),
    );
    const fixture = await render('T-148');
    const select = el(fixture).querySelector<HTMLSelectElement>('select')!;
    void select;

    const reassign = el(fixture).querySelector<HTMLSelectElement>('.reassign')!;
    reassign.value = 'PL-2';
    reassign.dispatchEvent(new Event('change'));
    await fixture.whenStable();

    expect(events.lastCommand('requestCardPipelineAssign')).toMatchObject({
      requestCardPipelineAssign: { cardId: 'T-148', pipelineId: 'PL-2' },
    });
  });

  it('surfaces a run rejection inline instead of failing silently', async () => {
    events.respondWith({
      ok: false,
      rejectionCode: 'invalidCommand',
      rejectionMessage: 'Project P-1 has no directory set',
    });

    const fixture = await render('T-148');
    const view = el(fixture);
    view.querySelector<HTMLButtonElement>('.run-button')!.click();
    await fixture.whenStable();

    expect(events.lastCommand('requestPipelineRun')).toBeDefined();
    expect(view.querySelector('.run-rejection')?.textContent).toContain(
      'Project P-1 has no directory set',
    );
  });

  it('shows how the last run ended once the run is gone', async () => {
    events.emit(
      wireEvent('pipelineRunStarted', { runId: 'R-1', cardId: 'T-148', pipelineId: 'PL-1', revision: 1 }),
    );
    events.emit(
      wireEvent('pipelineRunEnded', {
        runId: 'R-1',
        cardId: 'T-148',
        pipelineId: 'PL-1',
        revision: 1,
        status: WirePipelineRunStatus.PIPELINE_RUN_STATUS_FAILED,
        error: 'step st-1 failed',
      }),
    );

    const fixture = await render('T-148');
    const outcome = el(fixture).querySelector('.run-outcome');
    expect(outcome?.classList).toContain('failed');
    expect(outcome?.textContent).toContain('failed');
    expect(outcome?.textContent).toContain('step st-1 failed');
    // The outcome hops straight to the full-page run view.
    expect(outcome?.querySelector('.open-run')).toBeTruthy();
  });

  it('styles a returned run as actionable', async () => {
    events.emit(
      wireEvent('pipelineRunStarted', { runId: 'R-1', cardId: 'T-148', pipelineId: 'PL-1', revision: 1 }),
    );
    events.emit(
      wireEvent('pipelineRunEnded', {
        runId: 'R-1',
        cardId: 'T-148',
        pipelineId: 'PL-1',
        revision: 1,
        status: WirePipelineRunStatus.PIPELINE_RUN_STATUS_RETURNED,
        error: 'changes requested: needs tests',
      }),
    );

    const fixture = await render('T-148');
    const outcome = el(fixture).querySelector('.run-outcome');
    expect(outcome?.classList).toContain('failed');
    expect(outcome?.textContent).toContain('returned');
    expect(outcome?.textContent).toContain('changes requested: needs tests');
  });
});
