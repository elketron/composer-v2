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
  WireStage,
  WireSubStateStatus,
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
    seedCards();
  });

  function seedCards(): void {
    seedCard(events, {
      id: 'T-148',
      title: 'Diff overlay: syntax highlighting',
      description: 'Wire shiki, cache per language, lazy-load grammars.',
      stage: WireStage.STAGE_CODING,
      assignee: { role: 'coder', model: 'gpt-5.4', effort: 'medium' },
    });
    seedCard(events, {
      id: 'T-141',
      stage: WireStage.STAGE_VALIDATION,
      subState: {
        retrieveContext: WireSubStateStatus.SUB_STATE_STATUS_OK,
        implement: WireSubStateStatus.SUB_STATE_STATUS_OK,
        writeTests: WireSubStateStatus.SUB_STATE_STATUS_OK,
        runValidation: WireSubStateStatus.SUB_STATE_STATUS_RUNNING,
      },
      retries: { runValidation: 1 },
    });
    seedCard(events, {
      id: 'T-146',
      type: WireCardType.CARD_TYPE_DESIGN,
      stage: WireStage.STAGE_DESIGN,
    });
    seedCard(events, { id: 'T-139', stage: WireStage.STAGE_REVIEW });
    seedCard(events, { id: 'T-152', blockedBy: ['T-148'] });
    seedCard(events, { id: 'T-150', type: WireCardType.CARD_TYPE_DESIGN });
    seedCard(events, { id: 'T-131', stage: WireStage.STAGE_APPROVAL });
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

  it('renders the per-type pipeline checklist with statuses and retries', async () => {
    const fixture = await render('T-141');
    const rows = [...el(fixture).querySelectorAll('.check-row')];
    expect(rows.length).toBe(7);
    expect(rows.map((r) => r.querySelector('.check-label')!.textContent!.trim())).toEqual([
      'retrieve context',
      'implement',
      'write tests',
      'run validation',
      'review changes',
      'security review',
      'human review',
    ]);
    const validation = rows[3];
    expect(validation.classList).toContain('running');
    expect(validation.querySelector('.retries')?.textContent).toContain('1');
    // Design/docs checklists have no security stage.
    const design = await render('T-146');
    const labels = [...el(design).querySelectorAll('.check-label')].map((l) =>
      l.textContent!.trim(),
    );
    expect(labels).not.toContain('security review');
  });

  it('changes the card type from the picker and resets the checklist', async () => {
    const fixture = await render('T-139');
    const options = [...el(fixture).querySelectorAll<HTMLButtonElement>('.type-option')];
    const docs = options.find((o) => o.textContent!.includes('docs'))!;
    docs.click();
    await fixture.whenStable();

    const changed = await cardOf(fixture, 'T-139');
    expect(changed.type).toBe('docs');
    expect(changed.checklist().map((e) => e.stage)).not.toContain('securityReview');
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

  it('force-moves via the lane select', async () => {
    const fixture = await render('T-150');
    const select = el(fixture).querySelector<HTMLSelectElement>('.force-move select')!;
    select.value = 'design';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(service.cardsById().get('T-150')?.stage).toBe('design');
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
    await service.requestMove('T-131', 'coding');
    service.recordRejectionComment('needs more tests');
    const fixture = await render('T-131');
    expect(el(fixture).querySelector('.rejection')?.textContent).toContain('needs more tests');
  });

  it('shows the run with the gate affordance and answers it', async () => {
    // A pipeline waiting at its gate on T-148.
    events.emit(
      wireEvent('pipelineSaved', {
        pipeline: {
          id: 'PL-1',
          projectId: 'P-1',
          name: 'Standard coding card',
          steps: [
            { id: 'st-1', kind: WirePipelineStepKind.PIPELINE_STEP_KIND_AGENT, agentKind: 'coder', instructions: 'x' },
            { id: 'st-2', kind: WirePipelineStepKind.PIPELINE_STEP_KIND_HUMAN, description: 'Approval' },
          ],
          updatedAt: '',
        },
      }),
    );
    events.emit(wireEvent('pipelineRunStarted', { cardId: 'T-148', pipelineId: 'PL-1' }));
    events.emit(
      wireEvent('pipelineStepStarted', {
        cardId: 'T-148',
        pipelineId: 'PL-1',
        stepId: 'st-2',
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
    events.emit(
      wireEvent('pipelineSaved', {
        pipeline: {
          id: 'PL-1',
          projectId: 'P-1',
          name: 'Standard coding card',
          steps: [{ id: 'st-1', kind: WirePipelineStepKind.PIPELINE_STEP_KIND_AGENT, agentKind: 'coder', instructions: 'x' }],
          updatedAt: '',
        },
      }),
    );

    const fixture = await render('T-148');
    const view = el(fixture);
    // No run yet: the start affordance.
    expect(view.querySelector('.run-progress')).toBeNull();
    const select = view.querySelector<HTMLSelectElement>('.run-start select')!;
    select.value = 'PL-1';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    view.querySelector<HTMLButtonElement>('.run-button')!.click();
    await fixture.whenStable();
    expect(events.lastCommand('requestPipelineRun')).toMatchObject({
      requestPipelineRun: { pipelineId: 'PL-1', cardId: 'T-148' },
    });

    // Once running: the stop affordance replaces the start affordance.
    events.emit(wireEvent('pipelineRunStarted', { cardId: 'T-148', pipelineId: 'PL-1' }));
    events.emit(
      wireEvent('pipelineStepStarted', {
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
});
