import { TestBed, type ComponentFixture } from '@angular/core/testing';

import {
  FakeEventsClient,
  provideFakeEventsClient,
  seedProject,
  wireEvent,
} from '../core/events/events-client.fake';
import { ConfirmService } from '../core/confirm/confirm.service';
import { RestClient } from '../core/rest';
import { ShellService } from '../shell/shell.service';
import { PipelineEditorComponent } from './pipeline-editor.component';
import { PipelineService } from './pipeline.service';

describe('PipelineEditorComponent', () => {
  let events: FakeEventsClient;
  let restCalls: string[];
  let restResponse: { ok: boolean; body: unknown } | null;

  beforeEach(async () => {
    events = new FakeEventsClient();
    restCalls = [];
    restResponse = null;
    await TestBed.configureTestingModule({
      imports: [PipelineEditorComponent],
      providers: [
        provideFakeEventsClient(events),
        {
          provide: RestClient,
          useValue: {
            get: (path: string) => {
              restCalls.push(path);
              return Promise.resolve(restResponse);
            },
          },
        },
      ],
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
          lanes: [
            { id: 'ln-1', label: 'coder', kanbanVisible: true },
            { id: 'ln-2', label: 'Approval', kanbanVisible: true },
            { id: 'ln-3', label: 'done', kanbanVisible: true, terminal: true },
          ],
          steps: [
            { id: 'st-1', kind: 'agent', laneId: 'ln-1', agentKind: 'coder', instructions: 'Implement the card.' },
            { id: 'st-2', kind: 'command', laneId: 'ln-1', command: 'npm test', description: 'Run tests' },
            { id: 'st-3', kind: 'human', laneId: 'ln-2', description: 'Approval' },
          ],
          updatedAt: new Date().toISOString(),
        },
      }),
    );
  }

  async function openEditor(fixture: ComponentFixture<PipelineEditorComponent>): Promise<void> {
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.side-item')!.click();
    await fixture.whenStable();
  }

  async function newPipeline(fixture: ComponentFixture<PipelineEditorComponent>): Promise<void> {
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.side-head .icon')!.click();
    await fixture.whenStable();
  }

  it('groups pipelines by category in the sidebar', async () => {
    seedPipeline();
    events.emit(
      wireEvent('pipelineSaved', {
        pipeline: {
          id: 'PL-2',
          projectId: 'P-1',
          name: 'Doc pass',
          category: 'documentation',
          revision: 1,
          lanes: [
            { id: 'ln-1', label: 'writer', kanbanVisible: true },
            { id: 'ln-2', label: 'done', kanbanVisible: true, terminal: true },
          ],
          steps: [{ id: 'st-1', kind: 'agent', laneId: 'ln-1', agentKind: 'coder' }],
          updatedAt: new Date().toISOString(),
        },
      }),
    );
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    const groups = [...el.querySelectorAll('.side-group')];
    expect(groups).toHaveLength(2);
    expect(groups[0]!.querySelector('.side-group-label')?.textContent?.trim()).toBe('Documentation');
    expect(groups[0]!.querySelector('.side-item .item-name')?.textContent?.trim()).toBe('Doc pass');
    expect(groups[1]!.querySelector('.side-group-label')?.textContent?.trim()).toBe('General');
    expect(groups[1]!.textContent).toContain('Standard coding card');
  });

  it('renders the pipeline as a linear diagram of step nodes', async () => {
    seedPipeline();
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    await openEditor(fixture);

    expect(el.querySelectorAll('.diagram .node')).toHaveLength(4);
    expect([...el.querySelectorAll('.node-label')].map((node) => node.textContent?.trim())).toEqual([
      'coder',
      'Run tests',
      'approval',
      'done',
    ]);
    expect([...el.querySelectorAll('.node-kind')].map((node) => node.textContent?.trim())).toEqual([
      'Agent',
      'Set',
      'Approval',
      'Completion',
    ]);
    expect([...el.querySelectorAll('.node-stage')].map((node) => node.textContent?.trim())).toEqual([
      'Lane',
      'Hidden',
      'Lane',
      'done',
    ]);
  });

  it('offers the step-type palette from add step and inserts the picked preset', async () => {
    seedPipeline();
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    await openEditor(fixture);

    el.querySelector<HTMLButtonElement>('.add-node')!.click();
    await fixture.whenStable();

    const columns = [...el.querySelectorAll('.palette .palette-title')].map((node) => node.textContent?.trim());
    expect(columns).toEqual(['Agent step', 'Approval step', 'Set step', 'Completion step']);

    const reviewer = [...el.querySelectorAll<HTMLButtonElement>('.palette-item')].find(
      (item) => item.querySelector('.palette-item-label')?.textContent?.trim() === 'reviewer',
    );
    expect(reviewer).toBeDefined();
    reviewer!.click();
    await fixture.whenStable();

    const draft = (
      fixture.componentInstance as unknown as { editing: () => { steps: readonly { agentKind: string }[] } }
    ).editing();
    expect(draft.steps[draft.steps.length - 2]).toMatchObject({ kind: 'agent', agentKind: 'reviewer' });
  });

  it('opens the side panel with the selected node settings', async () => {
    seedPipeline();
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    await openEditor(fixture);

    el.querySelectorAll<HTMLButtonElement>('.node-select')[0]!.click();
    await fixture.whenStable();

    expect(el.querySelector('.panel .panel-title')?.textContent).toContain('Step 1');
    expect(el.querySelector('.panel .panel-title')?.textContent).toContain('coder');
    expect(el.querySelector<HTMLSelectElement>('.field.agent select')!.value).toBe('coder');
    expect(el.querySelector<HTMLInputElement>('.flag input[type="checkbox"]')!.checked).toBe(true);
    // The General tab carries the agent step's instructions field.
    expect(el.querySelector<HTMLTextAreaElement>('.field textarea')).not.toBeNull();
  });

  it('authors and saves a new pipeline from the diagram and side panel', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    await newPipeline(fixture);

    await type(fixture, el.querySelector<HTMLInputElement>('.edit-bar input.name')!, 'Quick fix');
    el.querySelector<HTMLButtonElement>('.node-select')!.click();
    await fixture.whenStable();
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
              laneId: 'ln-1',
              agentKind: 'coder',
            },
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
    el.querySelectorAll<HTMLButtonElement>('.panel-tab')[1]!.click();
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

  it('visualizes a step backward routes (outcomes and failure)', async () => {
    events.emit(
      wireEvent('pipelineSaved', {
        pipeline: {
          id: 'PL-1',
          projectId: 'P-1',
          name: 'review loop',
          revision: 1,
          lanes: [
            { id: 'ln-1', label: 'coder', kanbanVisible: true },
            { id: 'ln-2', label: 'reviewer', kanbanVisible: true },
            { id: 'ln-3', label: 'done', kanbanVisible: true, terminal: true },
          ],
          steps: [
            { id: 'st-1', kind: 'agent', laneId: 'ln-1', agentKind: 'coder' },
            {
              id: 'st-2',
              kind: 'agent',
              laneId: 'ln-2',
              agentKind: 'reviewer',
              outcomes: [{ outcome: 'approved' }, { outcome: 'changes_requested', toLaneId: 'ln-1' }],
              requiresOutcome: true,
              errorReturnToLaneId: 'ln-1',
            },
          ],
          updatedAt: new Date().toISOString(),
        },
      }),
    );
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    await openEditor(fixture);

    const chips = [...el.querySelectorAll('.diagram .route-chip')];
    expect(chips).toHaveLength(2);
    expect(chips[0]!.textContent).toContain('changes_requested');
    expect(chips[0]!.classList).toContain('failure');
    expect(chips[1]!.textContent).toContain('failure');
    expect(chips[1]!.classList).toContain('failure');
    const edges = [...el.querySelectorAll('.diagram .route-edge')];
    expect(edges).toHaveLength(2);
    expect(edges[0]!.getAttribute('marker-end')).toBe('url(#route-arrow-err)');
    expect(edges[1]!.getAttribute('marker-end')).toBe('url(#route-arrow-err)');
  });

  it('separates step type, execution, board, and error recovery in the General tab', async () => {
    seedPipeline();
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    await openEditor(fixture);

    el.querySelectorAll<HTMLButtonElement>('.node-select')[0]!.click();
    await fixture.whenStable();

    const labels = [...el.querySelectorAll('.panel .group-label')].map((node) => node.textContent?.trim());
    expect(labels).toEqual(['step type', 'execution', 'board', 'on execution error']);
  });

  it('shows validation only after save and resets it for the next draft', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    await newPipeline(fixture);
    expect(el.querySelector('.edit-error')).toBeNull();

    el.querySelector<HTMLButtonElement>('.edit-bar .save')!.click();
    await fixture.whenStable();
    expect(el.querySelector('.edit-error')?.textContent).toContain('Pipeline name is required');
    el.querySelector<HTMLButtonElement>('.edit-bar .back')!.click();
    await fixture.whenStable();
    await newPipeline(fixture);
    await fixture.whenStable();
    expect(el.querySelector('.edit-error')).toBeNull();
  });

  it('closes an open draft when the active project changes', async () => {
    seedProject(events, 'P-2');
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    await newPipeline(fixture);
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
    await openEditor(fixture);

    el.querySelector<HTMLButtonElement>('.edit-bar .overflow')!.click();
    await fixture.whenStable();
    el.querySelector<HTMLButtonElement>('.menu-item.danger')!.click();
    await fixture.whenStable();
    expect(events.lastCommand('requestPipelineDelete')).toBeUndefined();

    TestBed.inject(ConfirmService).resolve(true);
    await fixture.whenStable();
    expect(events.lastCommand('requestPipelineDelete')).toMatchObject({
      requestPipelineDelete: { pipelineId: 'PL-1' },
    });
  });

  it('picks a category in the settings tab and saves it', async () => {
    seedPipeline();
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    await openEditor(fixture);

    el.querySelectorAll<HTMLButtonElement>('.editor-tabs .tab')[1]!.click();
    await fixture.whenStable();
    await select(fixture, el.querySelector<HTMLSelectElement>('.settings select')!, 'research');
    el.querySelector<HTMLButtonElement>('.edit-bar .save')!.click();
    await fixture.whenStable();

    expect(events.lastCommand('requestPipelineSave')?.requestPipelineSave?.pipeline).toMatchObject({
      id: 'PL-1',
      name: 'Standard coding card',
      category: 'research',
    });
  });

  it('offers the project justfile recipes as palette presets and inspector recipes', async () => {
    seedPipeline();
    restCalls = [];
    restResponse = { ok: true, body: { recipes: [{ name: 'check', description: 'Run the checks' }] } };
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    await openEditor(fixture);

    expect(restCalls).toContain('/justfile?projectId=P-1');

    // The Set step palette column carries the recipe as a preset.
    el.querySelector<HTMLButtonElement>('.add-node')!.click();
    await fixture.whenStable();
    const preset = [...el.querySelectorAll<HTMLButtonElement>('.palette-item')].find(
      (item) => item.querySelector('.palette-item-label')?.textContent?.trim() === 'just check',
    );
    expect(preset).toBeDefined();
    preset!.click();
    await fixture.whenStable();

    const component = fixture.componentInstance as unknown as {
      editing: () => { steps: readonly { command?: string; description?: string }[] };
    };
    expect(component.editing().steps[component.editing().steps.length - 2]).toMatchObject({
      kind: 'command',
      command: 'just check',
      description: 'check',
    });

    // The command step's inspector lists the recipes for a re-pick.
    const justLabel = [...el.querySelectorAll('.panel label.field')].find(
      (label) => label.querySelector('.field-label')?.textContent?.trim() === 'justfile recipe',
    );
    const justSelect = justLabel?.querySelector('select');
    expect(justSelect).not.toBeNull();
    await select(fixture, justSelect!, 'check');
    expect(component.editing().steps[component.editing().steps.length - 2]?.command).toBe('just check');
  });
});
