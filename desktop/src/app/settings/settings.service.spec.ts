import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { FakeEventsClient, provideFakeEventsClient } from '../core/events/events-client.fake';
import { ShellService } from '../shell/shell.service';
import { SettingsService } from './settings.service';

describe('SettingsService', () => {
  let events: FakeEventsClient;
  let shell: ShellService;
  let service: SettingsService;
  let fetchJson: (url: string, init?: RequestInit) => { status: number; body: unknown };

  beforeEach(async () => {
    events = new FakeEventsClient();
    await TestBed.configureTestingModule({
      providers: [provideFakeEventsClient(events)],
    }).compileComponents();
    shell = TestBed.inject(ShellService);
    service = TestBed.inject(SettingsService);
    fetchJson = () => ({ status: 200, body: {} });
    vi.spyOn(globalThis, 'fetch').mockImplementation(((url: string, init?: RequestInit) => {
      const { status, body } = fetchJson(url, init);
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }) as typeof fetch);
  });

  it('loads the model from the server into the shell badge', async () => {
    fetchJson = () => ({ status: 200, body: { model: 'llamacpp/qwen3.6' } });
    await service.load();

    expect(service.model()).toBe('llamacpp/qwen3.6');
    expect(shell.model()).toBe('llamacpp/qwen3.6');
  });

  it('saves the draft and reflects the saved value', async () => {
    fetchJson = (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model?: string | null };
      return { status: 200, body: { model: body.model ?? '' } };
    };
    service.setDraft('llamacpp/qwen3.6');
    const ok = await service.save();

    expect(ok).toBe(true);
    expect(service.model()).toBe('llamacpp/qwen3.6');
    expect(shell.model()).toBe('llamacpp/qwen3.6');
    expect(service.error()).toBeNull();
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls.at(-1) as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain('/settings');
    expect(JSON.parse(String(init.body))).toEqual({ model: 'llamacpp/qwen3.6' });
  });

  it('an empty draft clears the override (the shell shows the default)', async () => {
    fetchJson = (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model?: string | null };
      return { status: 200, body: { model: body.model ?? '' } };
    };
    service.setDraft('  ');
    const ok = await service.save();

    expect(ok).toBe(true);
    expect(shell.model()).toBe('default');
    const [, init] = vi.mocked(globalThis.fetch).mock.calls.at(-1) as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(init.body))).toEqual({ model: null });
  });

  it('surfaces a refused save as an error', async () => {
    fetchJson = () => ({ status: 400, body: { error: 'malformed settings' } });
    service.setDraft('not a model');
    const ok = await service.save();

    expect(ok).toBe(false);
    expect(service.error()).toContain('refused');
  });
});
