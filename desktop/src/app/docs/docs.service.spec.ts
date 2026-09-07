import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { FakeEventsClient, provideFakeEventsClient, wireEvent } from '../core/events/events-client.fake';
import { DocsService } from './docs.service';

describe('DocsService', () => {
  let events: FakeEventsClient;
  let service: DocsService;
  let fetchJson: (url: string) => { status: number; body: unknown };

  beforeEach(async () => {
    events = new FakeEventsClient();
    await TestBed.configureTestingModule({
      providers: [provideFakeEventsClient(events)],
    }).compileComponents();
    service = TestBed.inject(DocsService);
    fetchJson = () => ({ status: 200, body: {} });
    vi.spyOn(globalThis, 'fetch').mockImplementation(((url: string) => {
      const { status, body } = fetchJson(url);
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }) as typeof fetch);
  });

  it('open loads the project index over REST, sorted by path', async () => {
    fetchJson = () => ({
      status: 200,
      body: {
        docs: [
          { path: 'b.md', title: 'B', size: 2, updatedAt: '2026-09-06T10:00:00Z' },
          { path: 'a.md', title: 'A', size: 1, updatedAt: '2026-09-06T09:00:00Z' },
        ],
      },
    });
    await service.open('P-1');

    const [url] = vi.mocked(globalThis.fetch).mock.calls[0] as unknown as [string];
    expect(url).toContain('/projects/P-1/docs');
    expect(service.docs('P-1').map((doc) => doc.path)).toEqual(['a.md', 'b.md']);
    expect(service.error()).toBeNull();
  });

  it('a server-reported error surfaces and keeps the index empty', async () => {
    fetchJson = () => ({ status: 200, body: { error: 'project P-1 has no directory' } });
    await service.open('P-1');

    expect(service.docs('P-1')).toEqual([]);
    expect(service.error()).toContain('no directory');
  });

  it('docSaved upserts and docDeleted removes — only for opened projects', async () => {
    fetchJson = () => ({ status: 200, body: { docs: [] } });
    await service.open('P-1'); // index now live
    events.emit(wireEvent('docSaved', { doc: { path: 'a.md', title: 'A', size: 1, updatedAt: '' } }, 'P-1'));
    events.emit(wireEvent('docSaved', { doc: { path: 'sub/b.md', title: 'B', size: 2, updatedAt: '' } }, 'P-1'));
    expect(service.docs('P-1').map((doc) => doc.path)).toEqual(['a.md', 'sub/b.md']);

    events.emit(
      wireEvent('docSaved', { doc: { path: 'a.md', title: 'A2', size: 3, updatedAt: '' } }, 'P-1'),
    );
    expect(service.docs('P-1').at(0)).toMatchObject({ path: 'a.md', title: 'A2', size: 3 });

    events.emit(wireEvent('docDeleted', { path: 'a.md' }, 'P-1'));
    expect(service.docs('P-1').map((doc) => doc.path)).toEqual(['sub/b.md']);

    // An unopened project's index stays empty — its view would fetch REST.
    events.emit(wireEvent('docSaved', { doc: { path: 'x.md', title: 'X', size: 1, updatedAt: '' } }, 'P-2'));
    expect(service.docs('P-2')).toEqual([]);
  });

  it('read fetches one doc content over REST', async () => {
    fetchJson = (url) =>
      url.includes('/docs/content')
        ? { status: 200, body: { doc: { path: 'a.md', title: 'A', size: 4, updatedAt: '', content: '# A\n' } } }
        : { status: 200, body: { docs: [] } };

    const result = await service.read('P-1', 'a.md');
    expect(result).toEqual({ ok: true, content: '# A\n' });

    fetchJson = () => ({ status: 200, body: { error: 'not a readable doc: x.md' } });
    expect(await service.read('P-1', 'x.md')).toEqual({
      ok: false,
      error: 'not a readable doc: x.md',
    });
  });

  it('save, rename, and delete publish their commands and surface rejections', async () => {
    expect(await service.save('P-1', 'a.md', '# A\n')).toEqual({ ok: true });
    expect(events.lastCommand('requestDocSave')).toEqual({
      projectId: 'P-1',
      requestDocSave: { path: 'a.md', content: '# A\n' },
    });

    events.respondWith({ ok: false, rejectionMessage: "doc 'x.md' already exists" });
    expect(await service.rename('P-1', 'a.md', 'x.md')).toEqual({
      ok: false,
      error: "doc 'x.md' already exists",
    });
    expect(events.lastCommand('requestDocRename')).toEqual({
      projectId: 'P-1',
      requestDocRename: { path: 'a.md', to: 'x.md' },
    });

    expect(await service.delete('P-1', 'a.md')).toEqual({ ok: true });
    expect(events.lastCommand('requestDocDelete')).toEqual({
      projectId: 'P-1',
      requestDocDelete: { path: 'a.md' },
    });
  });
});
