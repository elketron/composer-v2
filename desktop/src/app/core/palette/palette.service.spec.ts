import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import {
  FakeEventsClient,
  provideFakeEventsClient,
  seedProject,
} from '../events/events-client.fake';
import { ConfirmService } from '../confirm/confirm.service';
import { PaletteService } from './palette.service';

describe('PaletteService', () => {
  let events: FakeEventsClient;
  let palette: PaletteService;

  beforeEach(async () => {
    events = new FakeEventsClient();
    await TestBed.configureTestingModule({
      providers: [provideFakeEventsClient(events), provideRouter([])],
    }).compileComponents();
    TestBed.inject(PaletteService);
    seedProject(events, 'P-1', 'alpha');
    seedProject(events, 'P-2', 'beta');
    palette = TestBed.inject(PaletteService);
  });

  function labels(): string[] {
    return palette.results().map((item) => item.label);
  }

  it('lists shell destinations, project views, and actions when idle', () => {
    palette.openPalette();

    const all = labels();
    expect(all).toContain('go to projects');
    expect(all).toContain('open settings');
    expect(all).toContain('open alpha');
    expect(all).toContain('beta · plan');
    expect(all).toContain('archive beta');
    expect(all).toContain('new project');
    expect(all).toContain('refresh project health');
  });

  it('ranks label-prefix matches ahead of keyword matches', () => {
    palette.openPalette();
    palette.setQuery('bo');

    // "board" word-prefix matches rank before keyword-only hits.
    const all = labels();
    expect(all[0]).toBe('alpha · board');
    expect(all).toContain('beta · board');
  });

  it('matches keywords and falls back to subsequence matches', () => {
    palette.openPalette();
    palette.setQuery('kanban');
    expect(labels()).toContain('alpha · board');

    palette.setQuery('gtp');
    expect(labels()).toContain('go to projects');
  });

  it('moves the active index cyclically and executes the active entry', async () => {
    palette.openPalette();
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);

    expect(palette.activeIndex()).toBe(0);
    palette.move(-1);
    expect(palette.activeIndex()).toBe(palette.results().length - 1);
    palette.move(1);
    expect(palette.activeIndex()).toBe(0);

    await palette.executeAt();
    expect(navigate).toHaveBeenCalledWith('/dashboard');
    expect(palette.isOpen()).toBe(false);
  });

  it('runs the archive action through the confirmation dialog', async () => {
    palette.openPalette();
    palette.setQuery('archive alpha');
    // The palette closes around the action; the run resolves when the
    // dialog is answered.
    const executed = palette.executeAt(0);
    await new Promise((resolve) => setTimeout(resolve));

    expect(events.lastCommand('requestProjectArchive')).toBeUndefined();
    TestBed.inject(ConfirmService).resolve(true);
    await executed;
    expect(events.lastCommand('requestProjectArchive')?.requestProjectArchive).toEqual({
      projectId: 'P-1',
    });
  });

  it('a rejected confirmation publishes nothing', async () => {
    palette.openPalette();
    palette.setQuery('archive beta');
    const executed = palette.executeAt(0);
    await new Promise((resolve) => setTimeout(resolve));

    TestBed.inject(ConfirmService).resolve(false);
    await executed;
    expect(events.lastCommand('requestProjectArchive')).toBeUndefined();
  });
});
