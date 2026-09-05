import { TestBed } from '@angular/core/testing';

import type { ProjectDirectorySelection } from '../core/events/events-client';
import {
  FakeEventsClient,
  provideFakeEventsClient,
  wireEvent,
} from '../core/events/events-client.fake';
import { ShellService } from './shell.service';

function projectCreated(id: string, name: string) {
  return wireEvent(
    'projectCreated',
    { project: { id, name, createdAt: new Date().toISOString() } },
    id,
  );
}

describe('ShellService', () => {
  let service: ShellService;
  let events: FakeEventsClient;
  let selection: ProjectDirectorySelection | null;

  beforeEach(() => {
    events = new FakeEventsClient();
    selection = null;
    window.composer = {
      projects: {
        pickDirectory: async () => selection,
        discover: async () => null,
      },
    };
    TestBed.configureTestingModule({ providers: [provideFakeEventsClient(events)] });
    service = TestBed.inject(ShellService);
  });

  it('starts with no tabs and no active tab', () => {
    expect(service.tabs()).toEqual([]);
    expect(service.activeTab()).toBeNull();
  });

  it('folds ProjectCreated into tabs and lands on the first project', () => {
    events.emit(projectCreated('P-1', 'alpha'));
    events.emit(projectCreated('P-2', 'beta'));

    expect(service.tabs().map((t) => t.name)).toEqual(['alpha', 'beta']);
    // Startup snapshots carry no activation; the first project wins.
    expect(service.activeTab()?.name).toBe('alpha');
  });

  it('addTab publishes requestProjectCreate with the picked directory', async () => {
    selection = { name: 'composer', directory: '/work/composer' };

    await service.addTab();

    expect(events.lastCommand('requestProjectCreate')?.requestProjectCreate).toEqual({
      name: 'composer',
      directory: '/work/composer',
    });
    // The tab lands via the projectCreated echo, not locally.
    expect(service.tabs()).toEqual([]);
  });

  it('addTab publishes without a directory when none is picked', async () => {
    selection = { name: 'composer', directory: '' };

    await service.addTab();

    expect(events.lastCommand('requestProjectCreate')?.requestProjectCreate).toEqual({
      name: 'composer',
    });
  });

  it('links an existing project to a selected directory and folds the echo', async () => {
    events.emit(projectCreated('P-1', 'alpha'));
    selection = { name: 'alpha', directory: '/work/alpha' };

    await service.linkDirectory('P-1');

    expect(events.lastCommand('requestProjectSetDirectory')?.requestProjectSetDirectory).toEqual({
      projectId: 'P-1',
      directory: '/work/alpha',
    });
    events.emit(
      wireEvent(
        'projectDirectoryChanged',
        { projectId: 'P-1', directory: '/work/alpha' },
        'P-1',
      ),
    );
    expect(service.activeTab()?.directory).toBe('/work/alpha');
  });

  it('does not publish when directory selection is cancelled', async () => {
    selection = null;

    await service.addTab();

    expect(events.published).toEqual([]);
  });

  it('activateTab switches and publishes RequestProjectActivate; unknown ids ignored', () => {
    events.emit(projectCreated('P-1', 'alpha'));
    events.emit(projectCreated('P-2', 'beta'));
    service.activateTab('P-2');

    service.activateTab('P-1');

    expect(service.activeTab()?.id).toBe('P-1');
    expect(events.lastCommand('requestProjectActivate')?.requestProjectActivate).toEqual({
      projectId: 'P-1',
    });

    const published = events.published.length;
    service.activateTab('does-not-exist');
    expect(service.activeTab()?.id).toBe('P-1');
    expect(events.published.length).toBe(published);
  });

  it('closeTab hides the tab locally and activates a neighbor', () => {
    events.emit(projectCreated('P-1', 'alpha'));
    events.emit(projectCreated('P-2', 'beta'));
    events.emit(projectCreated('P-3', 'gamma'));
    service.activateTab('P-2');

    service.closeTab('P-2');

    expect(service.tabs().map((t) => t.id)).toEqual(['P-1', 'P-3']);
    expect(service.activeTab()?.id).toBe('P-3');
  });

  it('closing the last tab clears the active tab', () => {
    events.emit(projectCreated('P-1', 'alpha'));
    service.closeTab('P-1');

    expect(service.tabs()).toEqual([]);
    expect(service.activeTab()).toBeNull();
  });
});
