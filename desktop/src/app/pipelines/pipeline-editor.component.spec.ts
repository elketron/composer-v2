import { TestBed, type ComponentFixture } from '@angular/core/testing';

import {
  FakeEventsClient,
  provideFakeEventsClient,
  seedProject,
  wireEvent,
} from '../core/events/events-client.fake';
import { ConfirmService } from '../core/confirm/confirm.service';
import { ShellService } from '../shell/shell.service';
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
    input: HTMLInputElement | HTMLTextAreaElement,
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
          steps: [
            { id: 'st-1', kind: 'agent', boardVisible: true, agentKind: 'coder', instructions: 'Implement the card.' },
            { id: 'st-2', kind: 'command', boardVisible: false, command: 'npm test', description: 'Run tests' },
            { id: 'st-3', kind: 'human', boardVisible: true, description: 'Approval' },
            { id: 'st-4', kind: 'human', boardVisible: true, terminal: true },
          ],
          updatedAt: new Date().toISOString(),
        },
      }),
    );
  }

  async function openEditor(fixture: ComponentFixture<PipelineEditorComponent>): Promise<void> {
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.row .mini')!.click();
    await fixture.whenStable();
  }

  it('lists pipelines with a step summary', async () => {
    seedPipeline();
    const fixture = await render();
    const row = (fixture.nativeElement as HTMLElement).querySelector('.row')!;

    expect(row.textContent).toContain('Standard coding card');
    expect(row.textContent).toContain('PL-1');
    expect(row.textContent).toContain('coder → Run tests → approval → done');
  });

  it('renders the pipeline as a linear diagram of step nodes', async () => {
    seedPipeline();
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    await openEditor(fixture);

    expect(el.querySelectorAll('.diagram .node')).toHaveLength(4);
    expect([...el.querySelectorAll('.node-label')].map((node) => node.textContent?.trim())).toEqual([
      'coder',
      'command',
      'approval',
      'done',
    ]);
    expect([...el.querySelectorAll('.node-stage')].map((node) => node.textContent?.trim())).toEqual([
      'swimlane',
      'hidden',
      'swimlane',
      'done',
    ]);
  });

  it('opens the side panel with the selected node settings', async () => {
    seedPipeline();
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    await openEditor(fixture);

    el.querySelectorAll<HTMLButtonElement>('.node-select')[0]!.click();
    await fixture.whenStable();

    expect(el.querySelector('.panel .panel-title')?.textContent).toContain('step 1');
    expect(el.querySelector<HTMLSelectElement>('.field.agent select')!.value).toBe('coder');
    expect(el.querySelector<HTMLTextAreaElement>('.field textarea')!.value).toBe('Implement the card.');
    expect(el.querySelector<HTMLInputElement>('.flag input[type="checkbox"]')!.checked).toBe(true);
  });

  it('authors and saves a new pipeline from the diagram and side panel', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.new')!.click();
    await fixture.whenStable();

    await type(fixture, el.querySelector<HTMLInputElement>('.edit-bar input.name')!, 'Quick fix');
    el.querySelector<HTMLButtonElement>('.node-select')!.click();
    await fixture.whenStable();
    await type(fixture, el.querySelector<HTMLTextAreaElement>('.field textarea')!, 'Implement it');
    el.querySelector<HTMLButtonElement>('.edit-bar .save')!.click();
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
              boardVisible: true,
              agentKind: 'coder',
              instructions: 'Implement it',
            },
            { id: 'st-2', kind: 'human', boardVisible: true, terminal: true },
          ],
        },
      },
    });
  });

  it('edits an agent step kind from the backend agent list', async () => {
    seedPipeline();
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    await openEditor(fixture);

    el.querySelectorAll<HTMLButtonElement>('.node-select')[0]!.click();
    await fixture.whenStable();
    await select(fixture, el.querySelector<HTMLSelectElement>('.field.agent select')!, 'reviewer');
    el.querySelector<HTMLButtonElement>('.edit-bar .save')!.click();
    await fixture.whenStable();

    expect(events.lastCommand('requestPipelineSave')?.requestPipelineSave?.pipeline.steps[0]).toMatchObject({
      agentKind: 'reviewer',
    });
  });

  it('only reorders nodes away from the terminal', async () => {
    seedPipeline();
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    await openEditor(fixture);

    const terminalDown = el
      .querySelectorAll<HTMLElement>('.node')[3]!
      .querySelectorAll<HTMLButtonElement>('.node-actions .mini')[1]!;
    expect(terminalDown.disabled).toBe(true);
  });

  it('authors outcomes in the selected step settings', async () => {
    seedPipeline();
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    await openEditor(fixture);

    el.querySelectorAll<HTMLButtonElement>('.node-select')[0]!.click();
    await fixture.whenStable();
    el.querySelector<HTMLButtonElement>('.add-outcome')!.click();
    await fixture.whenStable();
    await type(fixture, el.querySelector<HTMLInputElement>('.outcome-rule input')!, 'rework');
    await select(fixture, el.querySelector<HTMLSelectElement>('.outcome-rule select')!, '');
    el.querySelector<HTMLButtonElement>('.edit-bar .save')!.click();
    await fixture.whenStable();

    expect(events.lastCommand('requestPipelineSave')?.requestPipelineSave?.pipeline.steps[0]).toMatchObject({
      outcomes: [{ outcome: 'rework' }],
    });
  });

  it('shows validation only after save and resets it for the next draft', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.new')!.click();
    await fixture.whenStable();
    expect(el.querySelector('.edit-error')).toBeNull();

    el.querySelector<HTMLButtonElement>('.edit-bar .save')!.click();
    await fixture.whenStable();
    expect(el.querySelector('.edit-error')?.textContent).toContain('Pipeline name is required');
    el.querySelector<HTMLButtonElement>('.edit-bar .back')!.click();
    await fixture.whenStable();
    el.querySelector<HTMLButtonElement>('.new')!.click();
    await fixture.whenStable();
    expect(el.querySelector('.edit-error')).toBeNull();
  });

  it('closes an open draft when the active project changes', async () => {
    seedProject(events, 'P-2');
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.new')!.click();
    await fixture.whenStable();
    const staleSave = el.querySelector<HTMLButtonElement>('.edit-bar .save')!;
    const component = fixture.componentInstance as unknown as {
      editing: () => { projectId: string } | null;
    };
    expect(component.editing()?.projectId).toBe('P-1');

    TestBed.inject(ShellService).selectProject('P-2');
    await fixture.whenStable();

    expect(el.querySelector('.edit-bar')).toBeNull();
    staleSave.click();
    await fixture.whenStable();
    expect(events.lastCommand('requestPipelineSave')).toBeUndefined();
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
