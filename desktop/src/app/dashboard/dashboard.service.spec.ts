import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { EventsClient } from '../core/events/events-client';
import { DashboardService } from './dashboard.service';

describe('DashboardService', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('loads the server dashboard projection', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        projects: [
          {
            id: 'P-1',
            name: 'alpha',
            runningRuns: 0,
            waitingApprovals: [],
            failedRuns: [],
            git: { status: 'clean', branch: 'main' },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    TestBed.configureTestingModule({
      providers: [
        DashboardService,
        {
          provide: EventsClient,
          useValue: { connected: signal(false), serverBase: 'http://composer.test' },
        },
      ],
    });
    const service = TestBed.inject(DashboardService);

    await service.refresh();

    expect(fetchMock).toHaveBeenCalledWith('http://composer.test/dashboard');
    expect(service.forProject('P-1')).toMatchObject({
      name: 'alpha',
      git: { status: 'clean', branch: 'main' },
    });
    expect(service.loading()).toBe(false);
    expect(service.error()).toBeNull();
  });

  it('keeps the previous projection when refresh fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    TestBed.configureTestingModule({
      providers: [
        DashboardService,
        {
          provide: EventsClient,
          useValue: { connected: signal(false), serverBase: 'http://composer.test' },
        },
      ],
    });
    const service = TestBed.inject(DashboardService);
    service.projects.set([
      {
        id: 'P-1',
        name: 'alpha',
        runningRuns: 0,
        waitingApprovals: [],
        failedRuns: [],
        git: { status: 'clean' },
      },
    ]);

    await service.refresh();

    expect(service.projects()).toHaveLength(1);
    expect(service.error()).toBe('project health is temporarily unavailable');
  });
});
