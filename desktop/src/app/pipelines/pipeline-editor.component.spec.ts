import { TestBed, type ComponentFixture } from '@angular/core/testing';

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

  async function render(): Promise<ComponentFixture<PipelineEditorComponent>> {
    const fixture = TestBed.createComponent(PipelineEditorComponent);
    await fixture.whenStable();
    return fixture;
  }

  async function type(
    fixture: ComponentFixture<PipelineEditorComponent>,
    input: HTMLInputElement,
    value: string,
  ): Promise<void> {
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
  }

  async function select(
    fixture: ComponentFixture<PipelineEditorComponent>,
    input: HTMLSelectElement,
    value: string,
  ): Promise<void> {
    input.value = value;
    input.dispatchEvent(new Event('change'));
    await fixture.whenStable();
  }

  function seedPipeline(id = 'PL-1', name = 'Standard coding card'): void {
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
            { id: 'sg-3', label: 'Validation', kanbanVisible: false, errorReturnToStageId: 'sg-2' },
            { id: 'sg-4', label: 'Approval', kanbanVisible: true },
            { id: 'sg-5', label: 'Done', kanbanVisible: true, terminal: true },
          ],
          steps: [
            { id: 'st-1', kind: 'agent', stageId: 'sg-2', agentKind: 'coder', instructions: 'Implement the card.' },
            { id: 'st-2', kind: 'command', stageId: 'sg-3', command: 'npm test' },
            { id: 'st-3', kind: 'human', stageId: 'sg-4', description: 'Approval' },
          ],
          updatedAt: new Date().toISOString(),
        },
      }),
    );
  }

  it('lists pipelines with stage and step summaries', async () => {
    seedPipeline();
    const fixture = await render();
    const row = (fixture.nativeElement as HTMLElement).querySelector('.row')!;

    expect(row.textContent).toContain('Standard coding card');
    expect(row.textContent).toContain('PL-1');
    expect(row.textContent).toContain('agent → command → gate');
  });

  it('shows a compact stage path and a separate flat ordered step list', async () => {
    seedPipeline();
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.row .mini')!.click();
    await fixture.whenStable();

    expect([...el.querySelectorAll('.stage-name')].map((node) => node.textContent?.trim())).toEqual([
      'New',
      'Implementation',
      'Validation',
      'Approval',
      'Done',
    ]);
    expect(el.querySelectorAll('.steps > .step')).toHaveLength(3);
    expect(el.querySelector('.stage-card .step')).toBeNull();
    expect(el.querySelector('.stage-card.hidden-stage')).toBeTruthy();
    expect(el.querySelector('.stage-card.terminal')).toBeTruthy();
    expect(el.querySelectorAll('.step .stage-assignment select')).toHaveLength(3);
    expect(el.querySelector('.step-id')).toBeNull();
  });

  it('authors and saves a new pipeline from the flat step row', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.new')!.click();
    await fixture.whenStable();

    await type(fixture, el.querySelector<HTMLInputElement>('.name-row input')!, 'Quick fix');
    const fields = el.querySelectorAll<HTMLInputElement>('.step-fields input');
    await type(fixture, fields[0]!, 'coder');
    await type(fixture, fields[1]!, 'Implement it');
    el.querySelector<HTMLButtonElement>('.save')!.click();
    await fixture.whenStable();

    expect(events.lastCommand('requestPipelineSave')).toMatchObject({
      projectId: 'P-1',
      requestPipelineSave: {
        pipeline: {
          name: 'Quick fix',
          steps: [
            {
              id: 'st-1',
              kind: 'agent',
              stageId: 'sg-1',
              agentKind: 'coder',
              instructions: 'Implement it',
            },
          ],
        },
      },
    });
  });

  it('reassigns a step and moves it into the selected stage run region', async () => {
    seedPipeline();
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.row .mini')!.click();
    await fixture.whenStable();

    await select(fixture, el.querySelector<HTMLSelectElement>('.step .stage-assignment select')!, 'sg-3');
    const rows = [...el.querySelectorAll<HTMLElement>('.step')];
    expect(rows.map((row) => row.querySelector<HTMLSelectElement>('.stage-assignment select')?.value)).toEqual([
      'sg-3',
      'sg-3',
      'sg-4',
    ]);
    expect(rows[0]?.querySelector('input')?.value).toBe('npm test');
    expect(rows[1]?.querySelectorAll('input')[1]?.value).toBe('Implement the card.');

    el.querySelector<HTMLButtonElement>('.save')!.click();
    await fixture.whenStable();
    expect(
      events.lastCommand('requestPipelineSave')?.requestPipelineSave?.pipeline.steps.map((step) => step.id),
    ).toEqual(['st-2', 'st-1', 'st-3']);
  });

  it('moves populated stages and preserves valid step grouping', async () => {
    seedPipeline();
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.row .mini')!.click();
    await fixture.whenStable();

    // Move Implementation before New. Its step group follows it automatically.
    el.querySelectorAll<HTMLButtonElement>('.stage-actions')[1]!
      .querySelector<HTMLButtonElement>('.mini')!.click();
    await fixture.whenStable();
    expect([...el.querySelectorAll('.stage-name')].map((node) => node.textContent?.trim())).toEqual([
      'Implementation',
      'New',
      'Validation',
      'Approval',
      'Done',
    ]);
    el.querySelector<HTMLButtonElement>('.save')!.click();
    await fixture.whenStable();
    expect(
      events.lastCommand('requestPipelineSave')?.requestPipelineSave?.pipeline.steps.map((step) => step.stageId),
    ).toEqual(['sg-2', 'sg-3', 'sg-4']);
  });

  it('only reorders steps within the same stage', async () => {
    seedPipeline();
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.row .mini')!.click();
    await fixture.whenStable();

    const firstDown = el.querySelectorAll<HTMLButtonElement>('.step')[0]!.querySelectorAll<HTMLButtonElement>('.mini')[1]!;
    expect(firstDown.disabled).toBe(true);
  });

  it('refuses to remove a stage while steps are assigned to it', async () => {
    seedPipeline();
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.row .mini')!.click();
    await fixture.whenStable();

    el.querySelectorAll<HTMLElement>('.stage-card')[1]!.querySelector<HTMLButtonElement>('.danger')!.click();
    await fixture.whenStable();
    expect(el.querySelector('.state-error')?.textContent).toContain('Move the 1 step assigned to Implementation');
    expect(el.querySelectorAll('.stage-card')).toHaveLength(5);
  });

  it('authors outcomes in the selected stage settings', async () => {
    seedPipeline();
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.row .mini')!.click();
    await fixture.whenStable();

    el.querySelectorAll<HTMLButtonElement>('.stage-select')[1]!.click();
    await fixture.whenStable();
    el.querySelector<HTMLButtonElement>('.stage-settings .mini')!.click();
    await fixture.whenStable();
    await type(fixture, el.querySelector<HTMLInputElement>('.outcome-rule input')!, 'rework');
    await select(fixture, el.querySelector<HTMLSelectElement>('.outcome-rule select')!, 'sg-1');
    el.querySelector<HTMLButtonElement>('.save')!.click();
    await fixture.whenStable();

    expect(events.lastCommand('requestPipelineSave')?.requestPipelineSave?.pipeline.stages[1]).toMatchObject({
      outcomes: [{ outcome: 'rework', toStageId: 'sg-1' }],
    });
  });

  it('shows validation only after save and resets it for the next draft', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.new')!.click();
    await fixture.whenStable();
    expect(el.querySelector('.state-error')).toBeNull();

    el.querySelector<HTMLButtonElement>('.save')!.click();
    await fixture.whenStable();
    expect(el.querySelector('.state-error')?.textContent).toContain('Pipeline name is required');
    el.querySelector<HTMLButtonElement>('.cancel')!.click();
    await fixture.whenStable();
    el.querySelector<HTMLButtonElement>('.new')!.click();
    await fixture.whenStable();
    expect(el.querySelector('.state-error')).toBeNull();
  });

  it('deletes a pipeline after confirming', async () => {
    seedPipeline();
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.row .row-actions .danger')!.click();
    await fixture.whenStable();
    expect(events.lastCommand('requestPipelineDelete')).toBeUndefined();

    TestBed.inject(ConfirmService).resolve(true);
    await fixture.whenStable();
    expect(events.lastCommand('requestPipelineDelete')).toMatchObject({
      requestPipelineDelete: { pipelineId: 'PL-1' },
    });
  });
});
