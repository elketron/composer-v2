import { TestBed } from '@angular/core/testing';

import {
  FakeEventsClient,
  provideFakeEventsClient,
  seedProject,
  wireEvent,
} from '../core/events/events-client.fake';
import { ConfirmService } from '../core/confirm/confirm.service';
import { PipelineEditorComponent } from './pipeline-editor.component';
import { PipelineService } from './pipeline.service';

describe('PipelineEditorComponent', () => {
  let events: FakeEventsClient;

  beforeEach(async () => {
    events = new FakeEventsClient();
    await TestBed.configureTestingModule({
      imports: [PipelineEditorComponent],
      providers: [provideFakeEventsClient(events)],
    }).compileComponents();
    TestBed.inject(PipelineService);
    seedProject(events, 'P-1');
  });

  async function render() {
    const fixture = TestBed.createComponent(PipelineEditorComponent);
    await fixture.whenStable();
    return fixture;
  }

  function seedPipeline(id: string, name: string): void {
    events.emit(
      wireEvent('pipelineSaved', {
        pipeline: {
          id,
          projectId: 'P-1',
          name,
          revision: 2,
          stages: [
            { id: 'sg-1', label: 'New', kanbanVisible: true },
            { id: 'sg-2', label: 'Implementation', kanbanVisible: true },
            { id: 'sg-3', label: 'Validation', kanbanVisible: true, errorReturnToStageId: 'sg-2' },
            { id: 'sg-4', label: 'Approval', kanbanVisible: true },
            { id: 'sg-5', label: 'Done', kanbanVisible: true, terminal: true },
          ],
          steps: [
            { id: 'st-1', kind: 'agent', stageId: 'sg-2', agentKind: 'coder', instructions: 'Implement the card.' },
            { id: 'st-2', kind: 'command', stageId: 'sg-3', command: 'npm test', description: 'Run tests' },
            { id: 'st-3', kind: 'human', stageId: 'sg-4', description: 'Approval' },
          ],
          updatedAt: new Date().toISOString(),
        },
      }),
    );
  }

  it('lists the project’s pipelines with a step summary', async () => {
    seedPipeline('PL-1', 'Standard coding card');
    const fixture = await render();
    const rows = [...fixture.nativeElement.querySelectorAll('.row')];

    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('Standard coding card');
    expect(rows[0]?.textContent).toContain('PL-1');
    expect(rows[0]?.textContent).toContain('agent → command → gate');
  });

  it('authors a pipeline from scratch and publishes requestPipelineSave', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.new')!.click();
    await fixture.whenStable();

    // One default (agent) step; fill the name, the step id and the fields.
    const nameInput = el.querySelector<HTMLInputElement>('.name-row input')!;
    nameInput.value = 'Quick fix';
    nameInput.dispatchEvent(new Event('input'));
    const stepId = el.querySelector<HTMLInputElement>('.step-id')!;
    stepId.value = 'st-1';
    stepId.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    const agentFields = el.querySelectorAll<HTMLInputElement>('.step-fields input')!;
    agentFields[0]!.value = 'coder';
    agentFields[0]!.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    const instructions = el.querySelectorAll<HTMLInputElement>('.step-fields input')![1]!;
    instructions.value = 'Implement it';
    instructions.dispatchEvent(new Event('input'));
    await fixture.whenStable();

    el.querySelector<HTMLButtonElement>('.save')!.click();
    await fixture.whenStable();

    const published = events.lastCommand('requestPipelineSave');
    expect(published).toMatchObject({
      projectId: 'P-1',
      requestPipelineSave: {
        pipeline: {
          id: '',
          name: 'Quick fix',
          revision: 0,
          steps: [{ id: 'st-1', kind: 'agent', stageId: 'sg-1', agentKind: 'coder', instructions: 'Implement it' }],
        },
      },
    });
    // The starter draft carries a staged path (a terminal Done stage last).
    expect(published?.requestPipelineSave?.pipeline.stages.at(-1)).toMatchObject({ terminal: true });
    // The form closes; the pipeline lands via its echo.
    expect(el.querySelector('.form')).toBeNull();
  });

  it('blocks saving an incomplete step and shows the validation message', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.new')!.click();
    await fixture.whenStable();

    // A pristine draft shows no error styling and no message.
    expect(el.querySelector('.step.invalid')).toBeNull();
    expect(el.querySelector('.state-error')).toBeNull();

    // The name is missing: the first validation error wins.
    el.querySelector<HTMLButtonElement>('.save')!.click();
    await fixture.whenStable();

    expect(el.querySelector('.state-error')?.textContent).toContain('Pipeline name is required');
    expect(el.querySelector('.step.invalid')).not.toBeNull();

    // Fill the name and the step id; the missing instructions surface next.
    const nameInput = el.querySelector<HTMLInputElement>('.name-row input')!;
    nameInput.value = 'Quick fix';
    nameInput.dispatchEvent(new Event('input'));
    const stepId = el.querySelector<HTMLInputElement>('.step-id')!;
    stepId.value = 'st-1';
    stepId.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    el.querySelector<HTMLButtonElement>('.save')!.click();
    await fixture.whenStable();

    expect(el.querySelector('.state-error')?.textContent).toContain('an agent step needs instructions');
    expect(events.lastCommand('requestPipelineSave')).toBeUndefined();
  });

  it('offers the known agent kinds in the step picker (type-to-filter)', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.new')!.click();
    await fixture.whenStable();

    const datalist = el.querySelector('datalist#composer-agent-kinds');
    expect(datalist).toBeTruthy();
    const options = [...datalist!.querySelectorAll('option')].map((o) => o.getAttribute('value'));
    expect(options).toContain('planner');
    expect(options).toContain('coder');
    // The agent step's kind field is wired to the list.
    expect(el.querySelector('input[list="composer-agent-kinds"]')).toBeTruthy();
  });

  it('edits an existing pipeline and keeps its id (the upsert path)', async () => {
    seedPipeline('PL-1', 'Standard coding card');
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.row .mini')!.click();
    await fixture.whenStable();

    const nameInput = el.querySelector<HTMLInputElement>('.name-row input')!;
    expect(nameInput.value).toBe('Standard coding card');
    expect(el.querySelectorAll('.step').length).toBe(3);

    el.querySelector<HTMLButtonElement>('.save')!.click();
    await fixture.whenStable();

    const published = events.lastCommand('requestPipelineSave');
    expect(published).toMatchObject({
      requestPipelineSave: { pipeline: { id: 'PL-1' } },
    });
  });

  it('authors stage outcomes and publishes them with the save', async () => {
    seedPipeline('PL-1', 'Standard coding card');
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.row .mini')!.click();
    await fixture.whenStable();

    // A forward outcome on the first stage (no earlier stage to return to).
    const firstStage = el.querySelectorAll('.stage')[0]!;
    firstStage.querySelector<HTMLButtonElement>('.stage-row .mini')!.click();
    await fixture.whenStable();
    const forward = el.querySelector<HTMLInputElement>('.outcome-rule input')!;
    forward.value = 'approved';
    forward.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    const requires = firstStage.querySelector<HTMLInputElement>('.stage-row input[type="checkbox"]')!;
    requires.click();
    await fixture.whenStable();

    // A backward outcome on the second stage: returns to the first.
    const secondStage = el.querySelectorAll('.stage')[1]!;
    secondStage.querySelector<HTMLButtonElement>('.stage-row .mini')!.click();
    await fixture.whenStable();
    const backward = secondStage.querySelector<HTMLInputElement>('.outcome-rule input')!;
    backward.value = 'rework';
    backward.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    const target = secondStage.querySelector<HTMLSelectElement>('.outcome-rule select')!;
    target.value = 'sg-1';
    target.dispatchEvent(new Event('change'));
    await fixture.whenStable();

    el.querySelector<HTMLButtonElement>('.save')!.click();
    await fixture.whenStable();

    const stages = events.lastCommand('requestPipelineSave')?.requestPipelineSave?.pipeline.stages ?? [];
    expect(stages[0]).toMatchObject({ id: 'sg-1', outcomes: [{ outcome: 'approved' }], requiresOutcome: true });
    expect(stages[1]).toMatchObject({ id: 'sg-2', outcomes: [{ outcome: 'rework', toStageId: 'sg-1' }] });
    // The outcome-free stages stay clean.
    expect(stages[2]?.outcomes).toBeUndefined();
  });

  it('blocks saving an outcome without a name', async () => {
    seedPipeline('PL-1', 'Standard coding card');
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.row .mini')!.click();
    await fixture.whenStable();

    el.querySelectorAll('.stage')[0]!.querySelector<HTMLButtonElement>('.stage-row .mini')!.click();
    await fixture.whenStable();
    el.querySelector<HTMLButtonElement>('.save')!.click();
    await fixture.whenStable();

    expect(el.querySelector('.state-error')?.textContent).toContain('Stage 1: outcome 1 needs a name');
    expect(events.lastCommand('requestPipelineSave')).toBeUndefined();
  });

  it('deletes a pipeline after confirming', async () => {
    seedPipeline('PL-1', 'Standard coding card');
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.row .row-actions .danger')!.click();
    await fixture.whenStable();

    // Deletion waits on the confirmation dialog.
    expect(events.lastCommand('requestPipelineDelete')).toBeUndefined();
    TestBed.inject(ConfirmService).resolve(true);
    await fixture.whenStable();

    expect(events.lastCommand('requestPipelineDelete')).toMatchObject({
      requestPipelineDelete: { pipelineId: 'PL-1' },
    });
  });
});
