import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { FakeEventsClient, provideFakeEventsClient } from '../core/events/events-client.fake';
import { SettingsComponent } from './settings.component';
import { SettingsService } from './settings.service';

describe('SettingsComponent', () => {
  it('offers the opencode model catalog from every model field', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(((url: string) => {
      const body = url.endsWith('/models')
        ? { models: ['llama.cpp/qwen3.6', 'openai/gpt-5.6-sol'] }
        : { model: '', models: {} };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }) as typeof fetch);
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: [provideFakeEventsClient(new FakeEventsClient())],
    }).compileComponents();

    const service = TestBed.inject(SettingsService);
    await service.load();
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;

    const defaultInput = element.querySelector('app-model-picker input') as HTMLInputElement;
    defaultInput.value = 'gpt-5.6';
    defaultInput.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(
      [...element.querySelectorAll('app-model-picker [role="option"]')].map((option) =>
        option.textContent?.trim(),
      ),
    ).toEqual(['openai/gpt-5.6-sol']);

    defaultInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();
    expect(service.model()).toBe('openai/gpt-5.6-sol');
  });
});
