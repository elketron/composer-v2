import { TestBed } from '@angular/core/testing';

import {
  DirectoryPickerService,
  type ProjectDirectorySelection,
} from '../core/directory-picker/directory-picker.service';
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
  let pickerInitialDirectory: string | null | undefined;

  beforeEach(() => {
    events = new FakeEventsClient();
    selection = null;
    pickerInitialDirectory = undefined;
    window.composer = {
      projects: {
        discover: async () => null,
      },
    };
    TestBed.configureTestingModule({
      providers: [
        provideFakeEventsClient(events),
        {
          provide: DirectoryPickerService,
          useValue: {
            pick: async (initialDirectory?: string | null) => {
              pickerInitialDirectory = initialDirectory;
              return selection;
            },
          },
        },
      ],
    });
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
    expect(pickerInitialDirectory).toBeNull();
    events.emit(
      wireEvent('projectDirectoryChanged', { projectId: 'P-1', directory: '/work/alpha' }, 'P-1'),
    );
    expect(service.activeTab()?.directory).toBe('/work/alpha');
  });

  it('starts relinking from the project directory on the server', async () => {
    events.emit(
      wireEvent(
        'projectCreated',
        {
          project: {
            id: 'P-1',
            name: 'alpha',
            directory: '/srv/work/alpha',
            createdAt: new Date().toISOString(),
          },
        },
        'P-1',
      ),
    );

    await service.linkDirectory('P-1');

    expect(pickerInitialDirectory).toBe('/srv/work/alpha');
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

  it('selects route project context without publishing', () => {
    service.selectProject('P-9');

    expect(service.activeTabId()).toBe('P-9');
    expect(events.published).toEqual([]);
  });

  it('remembers the last coding workflow route per project', () => {
    service.rememberWorkspaceUrl('/projects/P-1/coding/plan');
    service.rememberWorkspaceUrl('/settings');

    expect(service.workspaceUrl('P-1')).toBe('/projects/P-1/coding/plan');
    expect(service.workspaceUrl('P-2')).toBe('/projects/P-2/coding/board');
  });

  it('archives via the server and folds the project into the archive', async () => {
    events.emit(projectCreated('P-1', 'alpha'));
    events.emit(projectCreated('P-2', 'beta'));

    expect(await service.archiveProject('P-1')).toBeNull();
    expect(events.lastCommand('requestProjectArchive')?.requestProjectArchive).toEqual({
      projectId: 'P-1',
    });
    events.emit(
      wireEvent(
        'projectArchived',
        { projectId: 'P-1', archivedAt: new Date().toISOString() },
        'P-1',
      ),
    );

    expect(service.activeProjects().map((project) => project.id)).toEqual(['P-2']);
    expect(service.archivedProjects().map((project) => project.id)).toEqual(['P-1']);
    expect(service.activeTab()).toBeNull();
  });

  it('restores an archived project via the server echo', async () => {
    events.emit(
      wireEvent(
        'projectCreated',
        {
          project: {
            id: 'P-1',
            name: 'alpha',
            createdAt: new Date().toISOString(),
            archivedAt: new Date().toISOString(),
          },
        },
        'P-1',
      ),
    );

    expect(service.activeProjects()).toEqual([]);
    expect(await service.restoreProject('P-1')).toBeNull();
    expect(events.lastCommand('requestProjectRestore')?.requestProjectRestore).toEqual({
      projectId: 'P-1',
    });
    events.emit(
      wireEvent(
        'projectRestored',
        { projectId: 'P-1', restoredAt: new Date().toISOString() },
        'P-1',
      ),
    );

    expect(service.activeProjects().map((project) => project.id)).toEqual(['P-1']);
    expect(service.archivedProjects()).toEqual([]);
  });
});
