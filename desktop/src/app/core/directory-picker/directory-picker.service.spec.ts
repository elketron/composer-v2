import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EventsClient } from '../events/events-client';
import { DirectoryPickerService } from './directory-picker.service';

describe('DirectoryPickerService', () => {
  afterEach(() => vi.unstubAllGlobals());

  function setup() {
    TestBed.configureTestingModule({
      providers: [{ provide: EventsClient, useValue: { serverBase: 'http://server' } }],
    });
    return TestBed.inject(DirectoryPickerService);
  }

  it('browses and selects paths from the attached server', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          directory: '/home/composer',
          name: 'composer',
          parent: '/home',
          directories: [{ name: 'source', path: '/home/composer/source' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const picker = setup();

    const selected = picker.pick('/home/composer');
    await vi.waitFor(() => expect(picker.listing()?.directory).toBe('/home/composer'));
    picker.select();

    await expect(selected).resolves.toEqual({ name: 'composer', directory: '/home/composer' });
    expect(fetchMock).toHaveBeenCalledWith('http://server/directories?path=%2Fhome%2Fcomposer');
  });

  it('starts at the server default and reports unavailable paths', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ directory: '/home/server', name: 'server', parent: '/home', directories: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'directory is unavailable' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const picker = setup();

    const selected = picker.pick();
    await vi.waitFor(() => expect(picker.listing()?.directory).toBe('/home/server'));
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://server/directories');

    await picker.browse('/missing');
    expect(picker.error()).toBe('directory is unavailable');
    picker.cancel();
    await expect(selected).resolves.toBeNull();
  });
});
