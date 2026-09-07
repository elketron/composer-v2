import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';

import {
  FakeEventsClient,
  provideFakeEventsClient,
  wireEvent,
} from '../core/events/events-client.fake';
import { ConfirmService } from '../core/confirm/confirm.service';
import { DocEditorComponent } from './doc-editor.component';
import { DocsComponent } from './docs.component';

// CodeMirror 6 needs a ResizeObserver and rAF; jsdom ships neither.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as Record<string, unknown>)['ResizeObserver'] ??= ResizeObserverStub;
(globalThis as Record<string, unknown>)['requestAnimationFrame'] ??= ((callback: (time: number) => void) =>
  setTimeout(() => callback(Date.now()), 16) as unknown as number);
(globalThis as Record<string, unknown>)['cancelAnimationFrame'] ??= ((id: unknown) =>
  clearTimeout(id as ReturnType<typeof setTimeout>));

describe('DocsComponent', () => {
  let events: FakeEventsClient;
  let fetchJson: (url: string) => { status: number; body: unknown };
  let confirm: ConfirmService;

  beforeEach(async () => {
    events = new FakeEventsClient();
    await TestBed.configureTestingModule({
      imports: [DocsComponent],
      providers: [provideFakeEventsClient(events), provideRouter([])],
    }).compileComponents();
    confirm = TestBed.inject(ConfirmService);
    fetchJson = () => ({ status: 200, body: {} });
    vi.spyOn(globalThis, 'fetch').mockImplementation(((url: string) => {
      const { status, body } = fetchJson(url);
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }) as typeof fetch);
  });

  /** Content for any doc read; the list by default. */
  function serveContent(content: string): void {
    fetchJson = (url) => {
      if (url.includes('/docs/content')) {
        return {
          status: 200,
          body: { doc: { path: 'a.md', title: 'A', size: content.length, updatedAt: '', content } },
        };
      }
      return { status: 200, body: { docs: [{ path: 'a.md', title: 'A', size: content.length, updatedAt: '' }] } };
    };
  }

  function seedWithDirectory(id: string, directory: string | undefined): void {
    events.emit(
      wireEvent(
        'projectCreated',
        {
          project: { id, name: id, createdAt: new Date().toISOString(), ...(directory ? { directory } : {}) },
        },
        id,
      ),
    );
  }

  /** The view's REST refresh isn't tracked by whenStable; wait for it. */
  async function settled(fixture: ComponentFixture<DocsComponent>): Promise<void> {
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  function el(fixture: ComponentFixture<DocsComponent>): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function clickEntry(fixture: ComponentFixture<DocsComponent>, path: string): void {
    const entry = [...el(fixture).querySelectorAll<HTMLButtonElement>('.entry')].find(
      (button) => button.querySelector('.path')?.textContent?.trim() === path,
    );
    if (!entry) throw new Error(`no entry for ${path}`);
    entry.click();
  }

  function clickAction(fixture: ComponentFixture<DocsComponent>, label: string): void {
    const button = [...el(fixture).querySelectorAll<HTMLButtonElement>('.action')].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!button) throw new Error(`no action '${label}'`);
    button.click();
  }

  /** Emits a full document text from the CodeMirror wrapper (as an edit would). */
  function typeInEditor(fixture: ComponentFixture<DocsComponent>, text: string): void {
    const editor = fixture.debugElement.query(By.directive(DocEditorComponent));
    if (!editor) throw new Error('no editor mounted');
    (editor.componentInstance as DocEditorComponent).contentChange.emit(text);
  }

  function mode(fixture: ComponentFixture<DocsComponent>): string {
    return (fixture.componentInstance as unknown as { mode(): string }).mode();
  }

  function setPath(fixture: ComponentFixture<DocsComponent>, value: string): void {
    const input = el(fixture).querySelector<HTMLInputElement>('.path-input')!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  it('a project without a directory points at directory linking', async () => {
    const fixture = TestBed.createComponent(DocsComponent);
    seedWithDirectory('P-1', undefined);
    await settled(fixture);

    expect(el(fixture).textContent).toContain('no directory linked');
    expect(el(fixture).querySelector('.link')).toBeTruthy();
    expect(el(fixture).querySelector('.panes')).toBeNull();
  });

  it('lists the docs index and renders the selected document', async () => {
    serveContent('# Setup guide\n\nRun `pnpm install`.');
    const fixture = TestBed.createComponent(DocsComponent);
    seedWithDirectory('P-1', '/tmp/project');
    await settled(fixture);

    const entries = [...el(fixture).querySelectorAll('.entry')].map((entry) => ({
      title: entry.querySelector('.title')?.textContent?.trim(),
      path: entry.querySelector('.path')?.textContent?.trim(),
    }));
    expect(entries).toEqual([{ title: 'A', path: 'a.md' }]);

    clickEntry(fixture, 'a.md');
    await settled(fixture);

    const viewer = el(fixture).querySelector('.document')!;
    expect(viewer.querySelector('h1')?.textContent).toContain('Setup guide');
    expect(viewer.querySelector('code')?.textContent).toContain('pnpm install');
  });

  it('an empty index shows the no-docs state with the create action', async () => {
    fetchJson = () => ({ status: 200, body: { docs: [] } });
    const fixture = TestBed.createComponent(DocsComponent);
    seedWithDirectory('P-1', '/tmp/project');
    await settled(fixture);

    expect(el(fixture).textContent).toContain('no docs yet');
    expect(el(fixture).querySelector('.new-doc')).toBeTruthy();
  });

  it('a server error renders in the list pane', async () => {
    fetchJson = () => ({ status: 200, body: { error: 'the docs of P-1 are unavailable' } });
    const fixture = TestBed.createComponent(DocsComponent);
    seedWithDirectory('P-1', '/tmp/project');
    await settled(fixture);

    expect(el(fixture).textContent).toContain('the docs of P-1 are unavailable');
  });

  it('live docSaved/docDeleted events update the open index', async () => {
    fetchJson = () => ({ status: 200, body: { docs: [{ path: 'old.md', title: 'Old', size: 1, updatedAt: '' }] } });
    const fixture = TestBed.createComponent(DocsComponent);
    seedWithDirectory('P-1', '/tmp/project');
    await settled(fixture);
    expect(el(fixture).querySelectorAll('.entry .path')[0]?.textContent).toContain('old.md');

    events.emit(wireEvent('docSaved', { doc: { path: 'new.md', title: 'New', size: 1, updatedAt: '' } }, 'P-1'));
    events.emit(wireEvent('docDeleted', { path: 'old.md' }, 'P-1'));
    await settled(fixture);

    const paths = [...el(fixture).querySelectorAll('.entry .path')].map(
      (path) => path.textContent?.trim(),
    );
    expect(paths).toEqual(['new.md']);
  });

  it('create mode saves a new doc and selects it', async () => {
    fetchJson = (url) => {
      if (url.includes('/docs/content')) {
        return {
          status: 200,
          body: { doc: { path: 'notes/idea.md', title: 'idea', size: 1, updatedAt: '', content: '# Idea\n' } },
        };
      }
      return { status: 200, body: { docs: [] } };
    };
    const fixture = TestBed.createComponent(DocsComponent);
    seedWithDirectory('P-1', '/tmp/project');
    await settled(fixture);

    el(fixture).querySelector<HTMLButtonElement>('.new-doc')!.click();
    await settled(fixture);
    expect(mode(fixture)).toBe('create');
    setPath(fixture, 'notes/idea.md');
    typeInEditor(fixture, '# Idea\n');
    await settled(fixture);

    clickAction(fixture, 'save');
    await settled(fixture);

    expect(events.lastCommand('requestDocSave')).toMatchObject({
      projectId: 'P-1',
      requestDocSave: { path: 'notes/idea.md', content: '# Idea\n' },
    });
    expect(mode(fixture)).toBe('view');
    expect(el(fixture).querySelector('.document')).toBeTruthy();
  });

  it('edit mode marks dirty and saves the edited text', async () => {
    serveContent('# A\n');
    const fixture = TestBed.createComponent(DocsComponent);
    seedWithDirectory('P-1', '/tmp/project');
    await settled(fixture);

    clickEntry(fixture, 'a.md');
    await settled(fixture);
    clickAction(fixture, 'edit');
    await settled(fixture);
    expect(mode(fixture)).toBe('edit');
    expect(el(fixture).querySelector('.dirty-mark')).toBeNull();

    typeInEditor(fixture, '# A\n\nmore text\n');
    await settled(fixture);
    expect(el(fixture).querySelector('.dirty-mark')).toBeTruthy();

    clickAction(fixture, 'save');
    await settled(fixture);

    expect(events.lastCommand('requestDocSave')).toMatchObject({
      projectId: 'P-1',
      requestDocSave: { path: 'a.md', content: '# A\n\nmore text\n' },
    });
    expect(mode(fixture)).toBe('view');
    expect(el(fixture).querySelector('.document')?.textContent).toContain('more text');
  });

  it('cancel with unsaved edits confirms before discarding', async () => {
    serveContent('# A\n');
    const fixture = TestBed.createComponent(DocsComponent);
    seedWithDirectory('P-1', '/tmp/project');
    await settled(fixture);

    clickEntry(fixture, 'a.md');
    await settled(fixture);
    clickAction(fixture, 'edit');
    await settled(fixture);
    typeInEditor(fixture, 'changed\n');

    clickAction(fixture, 'cancel');
    await fixture.whenStable();
    expect(confirm.current()).not.toBeNull();

    confirm.resolve(false);
    await fixture.whenStable();
    expect(mode(fixture)).toBe('edit');

    clickAction(fixture, 'cancel');
    await fixture.whenStable();
    confirm.resolve(true);
    await settled(fixture);
    expect(mode(fixture)).toBe('view');
  });

  it('delete confirms, publishes the command, and clears the selection', async () => {
    serveContent('# A\n');
    const fixture = TestBed.createComponent(DocsComponent);
    seedWithDirectory('P-1', '/tmp/project');
    await settled(fixture);

    clickEntry(fixture, 'a.md');
    await settled(fixture);
    clickAction(fixture, 'delete');
    await fixture.whenStable();
    expect(confirm.current()).not.toBeNull();

    confirm.resolve(true);
    await settled(fixture);
    expect(events.lastCommand('requestDocDelete')).toEqual({
      projectId: 'P-1',
      requestDocDelete: { path: 'a.md' },
    });
    expect(el(fixture).querySelector('.document')).toBeNull();
  });

  it('rename publishes requestDocRename with the new path', async () => {
    serveContent('# A\n');
    const fixture = TestBed.createComponent(DocsComponent);
    seedWithDirectory('P-1', '/tmp/project');
    await settled(fixture);

    clickEntry(fixture, 'a.md');
    await settled(fixture);
    clickAction(fixture, 'rename');
    await settled(fixture);
    expect(mode(fixture)).toBe('rename');
    setPath(fixture, 'guide/a.md');

    clickAction(fixture, 'rename');
    await settled(fixture);

    expect(events.lastCommand('requestDocRename')).toEqual({
      projectId: 'P-1',
      requestDocRename: { path: 'a.md', to: 'guide/a.md' },
    });
  });

  it('a dirty editor guards the route: confirmLeave asks and reports', async () => {
    serveContent('# A\n');
    const fixture = TestBed.createComponent(DocsComponent);
    seedWithDirectory('P-1', '/tmp/project');
    await settled(fixture);

    expect(await fixture.componentInstance.confirmLeave()).toBe(true);

    clickEntry(fixture, 'a.md');
    await settled(fixture);
    clickAction(fixture, 'edit');
    await settled(fixture);
    typeInEditor(fixture, 'changed\n');

    const leaving = fixture.componentInstance.confirmLeave();
    await fixture.whenStable();
    expect(confirm.current()).not.toBeNull();
    confirm.resolve(false);
    expect(await leaving).toBe(false);
  });

  it('the flow toggle plants a starter fence and lands canvas edits in the draft', async () => {
    serveContent('# Plain doc\n');
    const fixture = TestBed.createComponent(DocsComponent);
    seedWithDirectory('P-1', '/tmp/project');
    await settled(fixture);

    clickEntry(fixture, 'a.md');
    await settled(fixture);
    clickAction(fixture, 'edit');
    await settled(fixture);

    const flowButton = [...el(fixture).querySelectorAll<HTMLButtonElement>('.toggle')].find(
      (button) => button.textContent?.trim() === 'flow',
    )!;
    flowButton.click();
    await settled(fixture);

    // No fence existed: one was planted into the draft (and marked dirty).
    expect(el(fixture).querySelector('app-flow-editor')).toBeTruthy();
    expect(el(fixture).querySelector('.dirty-mark')).toBeTruthy();

    // A canvas edit (as the flow editor would emit) splices the fence.
    const editor = fixture.debugElement.query(By.css('app-flow-editor'));
    (editor.componentInstance as import('./flow/flow-editor.component').FlowEditorComponent).codeChange.emit(
      'flowchart TD\n%% composer: A 40,40\nA[Start]\n',
    );
    await settled(fixture);

    clickAction(fixture, 'save');
    await settled(fixture);

    const saved = events.lastCommand('requestDocSave') as {
      requestDocSave: { content: string };
    };
    expect(saved.requestDocSave.content).toContain('# Plain doc');
    expect(saved.requestDocSave.content).toContain('```mermaid');
    expect(saved.requestDocSave.content).toContain('%% composer: A 40,40');
    expect(saved.requestDocSave.content).toContain('A[Start]');
  });
});
