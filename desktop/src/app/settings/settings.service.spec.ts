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
    service.setModel('llamacpp/qwen3.6');
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
    expect(JSON.parse(String(init.body))).toEqual({ model: 'llamacpp/qwen3.6', models: {} });
  });

  it('an empty draft clears the override (the shell shows the default)', async () => {
    fetchJson = (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model?: string | null };
      return { status: 200, body: { model: body.model ?? '' } };
    };
    service.setModel('  ');
    const ok = await service.save();

    expect(ok).toBe(true);
    expect(shell.model()).toBe('default');
    const [, init] = vi.mocked(globalThis.fetch).mock.calls.at(-1) as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(init.body))).toEqual({ model: null, models: {} });
  });

  it('surfaces a refused save as an error', async () => {
    fetchJson = () => ({ status: 400, body: { error: 'malformed settings' } });
    service.setModel('not a model');
    const ok = await service.save();

    expect(ok).toBe(false);
    expect(service.error()).toContain('refused');
  });

  it('per-agent overrides ride the PUT and the picker list', async () => {
    service.setAgentModel('planner', 'planner-model');
    service.addAgent('reviewer');
    service.setAgentModel('reviewer', 'review-model');
    fetchJson = (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model?: unknown; models?: unknown };
      return { status: 200, body: { model: '', models: body.models } };
    };
    const ok = await service.save();

    expect(ok).toBe(true);
    const [, init] = vi.mocked(globalThis.fetch).mock.calls.at(-1) as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(init.body))).toEqual({
      model: null,
      models: { planner: 'planner-model', reviewer: 'review-model' },
    });
    // The picker now offers the custom kind (the shipped ones stay first).
    expect(service.agentKinds()).toEqual(['planner', 'coder', 'tester', 'reviewer', 'security']);
  });

  it('clearing an agent model drops the key on save', async () => {
    service.setAgentModel('coder', 'coder-model');
    service.setAgentModel('coder', '  ');
    fetchJson = (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { models?: unknown };
      return { status: 200, body: { model: '', models: body.models } };
    };
    await service.save();

    const [, init] = vi.mocked(globalThis.fetch).mock.calls.at(-1) as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(init.body))).toEqual({ model: null, models: {} });
    expect(service.models()).toEqual({});
  });

  it('load restores the per-agent overrides and the picker list', async () => {
    fetchJson = () => ({
      status: 200,
      body: { model: 'default-m', models: { planner: 'p-m', reviewer: 'r-m' } },
    });
    await service.load();

    expect(service.models()).toEqual({ planner: 'p-m', reviewer: 'r-m' });
    expect(service.agentKinds()).toEqual(['planner', 'coder', 'tester', 'reviewer', 'security']);
    expect(shell.model()).toBe('default-m');
  });
});
