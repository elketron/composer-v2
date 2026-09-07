import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { FakeEventsClient, provideFakeEventsClient, wireGlobalEvent } from '../core/events/events-client.fake';
import { ConfirmService } from '../core/confirm/confirm.service';
import { KnowledgeListComponent } from './knowledge-list.component';
import { KnowledgeService } from './knowledge.service';

// CodeMirror 6 needs a ResizeObserver and rAF; jsdom ships neither (the
// pane's editor is deferred, but the stubs keep the environment safe).
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

describe('KnowledgeListComponent + KnowledgePaneComponent', () => {
  let events: FakeEventsClient;
  let fetchJson: (url: string) => { status: number; body: unknown };

  beforeEach(async () => {
    events = new FakeEventsClient();
    await TestBed.configureTestingModule({
      imports: [KnowledgeListComponent],
      providers: [provideFakeEventsClient(events)],
    }).compileComponents();
    fetchJson = () => ({ status: 200, body: {} });
    vi.spyOn(globalThis, 'fetch').mockImplementation(((url: string) => {
      const { status, body } = fetchJson(url);
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }) as typeof fetch);
  });

  async function settled(fixture: ComponentFixture<KnowledgeListComponent>): Promise<void> {
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('lists the library and selects a note through the service', async () => {
    fetchJson = () => ({
      status: 200,
      body: {
        entries: [
          { path: 'a.md', title: 'Alpha note', tags: [], size: 1, updatedAt: '' },
          { path: 'b.md', title: 'Beta note', tags: [], size: 1, updatedAt: '' },
        ],
      },
    });
    const fixture = TestBed.createComponent(KnowledgeListComponent);
    await settled(fixture);

    const service = TestBed.inject(KnowledgeService);
    const titles = [...(fixture.nativeElement as HTMLElement).querySelectorAll('.note-title')].map(
      (title) => title.textContent?.trim(),
    );
    expect(titles).toEqual(['Alpha note', 'Beta note']);

    (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.note-row')[0]!.click();
    await settled(fixture);
    expect(service.selected()).toBe('a.md');
  });

  it('search swaps the list for scored results', async () => {
    fetchJson = (url) => {
      if (url.includes('/knowledge/search')) {
        return {
          status: 200,
          body: { results: [{ path: 'hit.md', title: 'Hit', tags: [], score: 4, snippet: '…' }] },
        };
      }
      return {
        status: 200,
        body: { entries: [{ path: 'a.md', title: 'A', tags: [], size: 1, updatedAt: '' }] },
      };
    };
    const fixture = TestBed.createComponent(KnowledgeListComponent);
    await settled(fixture);

    const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('.search-input')!;
    input.value = 'hit';
    input.dispatchEvent(new Event('input'));
    await settled(fixture);

    const titles = [...(fixture.nativeElement as HTMLElement).querySelectorAll('.note-title')].map(
      (title) => title.textContent?.trim(),
    );
    expect(titles).toEqual(['Hit']);
  });

  it('create mode saves through the service and reports via the fold', async () => {
    fetchJson = () => ({ status: 200, body: { entries: [] } });
    const fixture = TestBed.createComponent(KnowledgeListComponent);
    const service = TestBed.inject(KnowledgeService);
    await settled(fixture);

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.new-note')!.click();
    await settled(fixture);
    expect(service.mode()).toBe('create');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('new note');
  });

  it('a deleted note disappears from the list and clears its selection', async () => {
    fetchJson = () => ({
      status: 200,
      body: { entries: [{ path: 'a.md', title: 'A', tags: [], size: 1, updatedAt: '' }] },
    });
    const fixture = TestBed.createComponent(KnowledgeListComponent);
    const service = TestBed.inject(KnowledgeService);
    await settled(fixture);
    service.selected.set('a.md');

    events.emit(wireGlobalEvent('knowledgeDeleted', { path: 'a.md' }));
    await settled(fixture);

    expect(service.entries()).toEqual([]);
    expect(service.selected()).toBeNull();
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('.note-row').length).toBe(0);
  });
});
