import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { vi } from 'vitest';

import { FakeEventsClient, provideFakeEventsClient, wireGlobalEvent } from '../core/events/events-client.fake';
import { ConfirmService } from '../core/confirm/confirm.service';
import { DocEditorComponent } from '../docs/doc-editor.component';
import { KnowledgePaneComponent } from './knowledge-pane.component';
import { KnowledgeService } from './knowledge.service';

// CodeMirror 6 needs a ResizeObserver and rAF; jsdom ships neither. The
// editor rides a @defer block, so specs wait for the chunk to render.
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

describe('KnowledgePaneComponent', () => {
  let events: FakeEventsClient;
  let fetchJson: (url: string) => { status: number; body: unknown };
  let confirm: ConfirmService;

  const RAW = '---\ntitle: Alpha\ntags: alpha, test\n---\n\n# Alpha\n\nbody text\n';

  beforeEach(async () => {
    events = new FakeEventsClient();
    await TestBed.configureTestingModule({
      imports: [KnowledgePaneComponent],
      providers: [provideFakeEventsClient(events)],
    }).compileComponents();
    confirm = TestBed.inject(ConfirmService);
    fetchJson = () => ({
      status: 200,
      body: {
        entry: { path: 'alpha.md', title: 'Alpha', tags: ['alpha', 'test'], size: 1, updatedAt: '', content: RAW, body: '# Alpha\n\nbody text\n' },
      },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(((url: string) => {
      const { status, body } = fetchJson(url);
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }) as typeof fetch);
  });

  async function settled(fixture: ComponentFixture<KnowledgePaneComponent>): Promise<void> {
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  function el(fixture: ComponentFixture<KnowledgePaneComponent>): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function clickAction(fixture: ComponentFixture<KnowledgePaneComponent>, label: string): void {
    const button = [...el(fixture).querySelectorAll<HTMLButtonElement>('.action')].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!button) throw new Error(`no action '${label}'`);
    button.click();
  }

  function typeInEditor(fixture: ComponentFixture<KnowledgePaneComponent>, text: string): void {
    const editor = fixture.debugElement.query(By.directive(DocEditorComponent));
    if (!editor) throw new Error('no editor mounted');
    (editor.componentInstance as DocEditorComponent).contentChange.emit(text);
  }

  it('an empty selection shows the guidance state', async () => {
    const fixture = TestBed.createComponent(KnowledgePaneComponent);
    await settled(fixture);

    expect(el(fixture).textContent).toContain('select a note');
    expect(el(fixture).querySelector('.note-body')).toBeNull();
  });

  it('renders the selected note (markdown, not frontmatter)', async () => {
    const fixture = TestBed.createComponent(KnowledgePaneComponent);
    const service = TestBed.inject(KnowledgeService);
    events.emit(
      wireGlobalEvent('knowledgeSaved', {
        entry: { path: 'alpha.md', title: 'Alpha', tags: ['alpha', 'test'], size: 1, updatedAt: '' },
      }),
    );
    service.selected.set('alpha.md');
    await settled(fixture);

    expect(el(fixture).querySelector('.note-path')?.textContent).toContain('alpha.md');
    expect(el(fixture).querySelector('.note-body h1')?.textContent).toContain('Alpha');
    expect(el(fixture).querySelector('.note-body')?.textContent).toContain('body text');
    expect(el(fixture).querySelector('.note-body')?.textContent).not.toContain('tags:');
  });

  it('edit mode prefills structured fields and saves the rebuilt file', async () => {
    const fixture = TestBed.createComponent(KnowledgePaneComponent);
    const service = TestBed.inject(KnowledgeService);
    events.emit(
      wireGlobalEvent('knowledgeSaved', {
        entry: { path: 'alpha.md', title: 'Alpha', tags: ['alpha', 'test'], size: 1, updatedAt: '' },
      }),
    );
    service.selected.set('alpha.md');
    await settled(fixture);

    clickAction(fixture, 'edit');
    await settled(fixture);
    expect(service.mode()).toBe('edit');

    const titleInput = el(fixture).querySelector<HTMLInputElement>('.title-field')!;
    expect(titleInput.value).toBe('Alpha');
    const tagsInput = el(fixture).querySelector<HTMLInputElement>('.tags-field')!;
    expect(tagsInput.value).toBe('alpha, test');

    titleInput.value = 'Alpha rewritten';
    titleInput.dispatchEvent(new Event('input'));
    typeInEditor(fixture, '# Alpha\n\nnew body\n');
    await settled(fixture);
    expect(el(fixture).querySelector('.dirty-mark')).toBeTruthy();

    clickAction(fixture, 'save');
    await settled(fixture);

    expect(events.lastCommand('requestKnowledgeSave')).toEqual({
      requestKnowledgeSave: {
        path: 'alpha.md',
        content: '---\ntitle: Alpha rewritten\ntags: alpha, test\n---\n\n# Alpha\n\nnew body\n',
      },
    });
    expect(service.mode()).toBe('view');
  });

  it('create mode requires a title and lands the note via create', async () => {
    const fixture = TestBed.createComponent(KnowledgePaneComponent);
    const service = TestBed.inject(KnowledgeService);
    await settled(fixture);

    await service.beginCreate();
    await settled(fixture);
    expect(service.mode()).toBe('create');
    expect(el(fixture).querySelector<HTMLInputElement>('.title-field')!.value).toBe('');

    clickAction(fixture, 'save');
    await settled(fixture);
    // Empty title: the save is disabled, nothing published.
    expect(events.lastCommand('requestKnowledgeSave')).toBeUndefined();

    const titleInput = el(fixture).querySelector<HTMLInputElement>('.title-field')!;
    titleInput.value = 'Fresh note';
    titleInput.dispatchEvent(new Event('input'));
    const tagsInput = el(fixture).querySelector<HTMLInputElement>('.tags-field')!;
    tagsInput.value = 'fresh';
    tagsInput.dispatchEvent(new Event('input'));
    typeInEditor(fixture, 'the body\n');
    await settled(fixture);

    clickAction(fixture, 'save');
    await settled(fixture);
    expect(events.lastCommand('requestKnowledgeSave')).toEqual({
      requestKnowledgeSave: { title: 'Fresh note', tags: ['fresh'], content: 'the body\n' },
    });
    expect(service.mode()).toBe('view');
  });

  it('cancel with unsaved edits confirms before discarding', async () => {
    const fixture = TestBed.createComponent(KnowledgePaneComponent);
    const service = TestBed.inject(KnowledgeService);
    await service.beginCreate();
    await settled(fixture);

    typeInEditor(fixture, 'draft text\n');
    await settled(fixture);

    clickAction(fixture, 'cancel');
    await fixture.whenStable();
    expect(confirm.current()).not.toBeNull();

    confirm.resolve(false);
    await fixture.whenStable();
    expect(service.mode()).toBe('create');

    clickAction(fixture, 'cancel');
    await fixture.whenStable();
    confirm.resolve(true);
    await settled(fixture);
    expect(service.mode()).toBe('view');
  });

  it('delete confirms and the tombstone clears the pane', async () => {
    const fixture = TestBed.createComponent(KnowledgePaneComponent);
    const service = TestBed.inject(KnowledgeService);
    events.emit(
      wireGlobalEvent('knowledgeSaved', {
        entry: { path: 'alpha.md', title: 'Alpha', tags: [], size: 1, updatedAt: '' },
      }),
    );
    service.selected.set('alpha.md');
    await settled(fixture);

    clickAction(fixture, 'delete');
    await fixture.whenStable();
    expect(confirm.current()).not.toBeNull();

    confirm.resolve(true);
    await settled(fixture);
    expect(events.lastCommand('requestKnowledgeDelete')).toEqual({
      requestKnowledgeDelete: { path: 'alpha.md' },
    });
    // The knowledgeDeleted event (emitted by the server) clears selection.
    events.emit(wireGlobalEvent('knowledgeDeleted', { path: 'alpha.md' }));
    await settled(fixture);
    expect(el(fixture).textContent).toContain('select a note');
  });
});
