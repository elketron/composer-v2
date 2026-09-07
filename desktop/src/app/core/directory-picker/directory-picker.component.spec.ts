import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EventsClient } from '../events/events-client';
import { DirectoryPickerComponent } from './directory-picker.component';
import { DirectoryPickerService } from './directory-picker.service';

describe('DirectoryPickerComponent', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('navigates server directories and selects the current folder', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        const child = url.includes('%2Fserver%2Fprojects');
        return new Response(
          JSON.stringify(
            child
              ? { directory: '/server/projects', name: 'projects', parent: '/server', directories: [] }
              : {
                  directory: '/server',
                  name: 'server',
                  parent: '/',
                  directories: [
                    { name: 'archive', path: '/server/archive' },
                    { name: 'projects', path: '/server/projects' },
                  ],
                },
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );
    TestBed.configureTestingModule({
      providers: [{ provide: EventsClient, useValue: { serverBase: 'http://server' } }],
    });
    const fixture = TestBed.createComponent(DirectoryPickerComponent);
    const picker = TestBed.inject(DirectoryPickerService);

    const selected = picker.pick('/server');
    await vi.waitFor(() => expect(picker.listing()?.directory).toBe('/server'));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[role="dialog"]')).toBeTruthy();
    expect(el.querySelectorAll('.directory')).toHaveLength(2);

    const input = el.querySelector<HTMLInputElement>('.path input')!;
    input.value = '/server/pro';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(el.querySelectorAll('.directory')).toHaveLength(1);
    expect(el.querySelector('.directory')?.textContent).toContain('projects');

    el.querySelector<HTMLButtonElement>('.directory')!.click();
    await vi.waitFor(() => expect(picker.listing()?.directory).toBe('/server/projects'));
    fixture.detectChanges();
    el.querySelector<HTMLButtonElement>('.select')!.click();

    await expect(selected).resolves.toEqual({ name: 'projects', directory: '/server/projects' });
    fixture.detectChanges();
    expect(el.querySelector('[role="dialog"]')).toBeNull();
  });
});
