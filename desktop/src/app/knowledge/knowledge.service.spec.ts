import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { FakeEventsClient, provideFakeEventsClient, wireGlobalEvent } from '../core/events/events-client.fake';
import { KnowledgeService } from './knowledge.service';

describe('KnowledgeService', () => {
  let events: FakeEventsClient;
  let service: KnowledgeService;
  let fetchJson: (url: string) => { status: number; body: unknown };

  beforeEach(async () => {
    events = new FakeEventsClient();
    await TestBed.configureTestingModule({
      providers: [provideFakeEventsClient(events)],
    }).compileComponents();
    service = TestBed.inject(KnowledgeService);
    fetchJson = () => ({ status: 200, body: {} });
    vi.spyOn(globalThis, 'fetch').mockImplementation(((url: string) => {
      const { status, body } = fetchJson(url);
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }) as typeof fetch);
  });

  it('open loads the library over REST, sorted by path', async () => {
    fetchJson = () => ({
      status: 200,
      body: {
        entries: [
          { path: 'b.md', title: 'B', tags: [], size: 1, updatedAt: '' },
          { path: 'a.md', title: 'A', tags: ['x'], size: 2, updatedAt: '' },
        ],
      },
    });
    await service.open();

    const [url] = vi.mocked(globalThis.fetch).mock.calls[0] as unknown as [string];
    expect(url).toContain('/knowledge');
    expect(service.entries().map((entry) => entry.path)).toEqual(['a.md', 'b.md']);
    expect(service.error()).toBeNull();
  });

  it('a server-reported error surfaces and keeps the list empty', async () => {
    fetchJson = () => ({ status: 200, body: { error: 'knowledge storage is unavailable' } });
    await service.open();

    expect(service.entries()).toEqual([]);
    expect(service.error()).toContain('unavailable');
  });

  it('knowledgeSaved upserts and knowledgeDeleted removes — only when loaded', async () => {
    fetchJson = () => ({ status: 200, body: { entries: [] } });
    await service.open();

    events.emit(
      wireGlobalEvent('knowledgeSaved', {
        entry: { path: 'a.md', title: 'A', tags: [], size: 1, updatedAt: '' },
      }),
    );
    events.emit(
      wireGlobalEvent('knowledgeSaved', {
        entry: { path: 'b.md', title: 'B', tags: ['x'], size: 2, updatedAt: '' },
      }),
    );
    expect(service.entries().map((entry) => entry.path)).toEqual(['a.md', 'b.md']);

    events.emit(
      wireGlobalEvent('knowledgeSaved', {
        entry: { path: 'a.md', title: 'A2', tags: [], size: 3, updatedAt: '' },
      }),
    );
    expect(service.entries().at(0)).toMatchObject({ path: 'a.md', title: 'A2' });

    events.emit(wireGlobalEvent('knowledgeDeleted', { path: 'a.md' }));
    expect(service.entries().map((entry) => entry.path)).toEqual(['b.md']);
    // A deletion clears the selection when it was the selected note.
    service.selected.set('b.md');
    events.emit(wireGlobalEvent('knowledgeDeleted', { path: 'b.md' }));
    expect(service.selected()).toBeNull();
  });

  it('read returns the raw file plus parsed metadata', async () => {
    fetchJson = (url) =>
      url.includes('/knowledge/content')
        ? {
            status: 200,
            body: {
              entry: {
                path: 'a.md',
                title: 'A',
                tags: ['x'],
                size: 1,
                updatedAt: '',
                content: '---\ntitle: A\ntags: x\n---\n\nbody\n',
                body: 'body\n',
              },
            },
          }
        : { status: 200, body: { entries: [] } };

    const result = await service.read('a.md');
    expect(result).toMatchObject({ ok: true, content: '---\ntitle: A\ntags: x\n---\n\nbody\n', body: 'body\n', title: 'A', tags: ['x'] });
  });

  it('search returns scored results', async () => {
    fetchJson = (url) =>
      url.includes('/knowledge/search')
        ? {
            status: 200,
            body: { results: [{ path: 'a.md', title: 'A', tags: ['x'], score: 5, snippet: 'the body' }] },
          }
        : { status: 200, body: { entries: [] } };

    const results = await service.search('a');
    expect(results).toEqual([
      { path: 'a.md', title: 'A', tags: ['x'], score: 5, snippet: 'the body' },
    ]);
  });

  it('save, create, and delete publish their commands', async () => {
    await service.saveEdit('a.md', '---\ntitle: A\n---\n\nbody\n');
    expect(events.lastCommand('requestKnowledgeSave')).toEqual({
      requestKnowledgeSave: { path: 'a.md', content: '---\ntitle: A\n---\n\nbody\n' },
    });

    events.respondWith({ ok: true });
    await service.createNote('New note', ['tag'], 'body');
    expect(events.lastCommand('requestKnowledgeSave')).toEqual({
      requestKnowledgeSave: { title: 'New note', tags: ['tag'], content: 'body' },
    });

    await service.delete('a.md');
    expect(events.lastCommand('requestKnowledgeDelete')).toEqual({
      requestKnowledgeDelete: { path: 'a.md' },
    });
  });

  it('selection and mode changes confirm before discarding unsaved work', async () => {
    const confirm = TestBed.inject((await import('../core/confirm/confirm.service')).ConfirmService);
    service.setEditingDirty(true);

    const selectPromise = service.select('a.md');
    expect(confirm.current()).not.toBeNull();
    confirm.resolve(false);
    expect(await selectPromise).toBe(false);
    expect(service.selected()).toBeNull();

    const retry = service.select('a.md');
    await confirm.current();
    confirm.resolve(true);
    expect(await retry).toBe(true);
    expect(service.selected()).toBe('a.md');
    expect(service.mode()).toBe('view');
  });
});
