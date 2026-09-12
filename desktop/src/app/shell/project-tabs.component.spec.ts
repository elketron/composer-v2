import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { vi } from 'vitest';

import {
  FakeEventsClient,
  provideFakeEventsClient,
  wireEvent,
} from '../core/events/events-client.fake';
import { ShellService } from './shell.service';
import { ProjectTabsComponent } from './project-tabs.component';

function projectCreated(id: string, name: string) {
  return wireEvent(
    'projectCreated',
    { project: { id, name, createdAt: new Date().toISOString() } },
    id,
  );
}

describe('ProjectTabsComponent', () => {
  let events: FakeEventsClient;

  beforeEach(async () => {
    events = new FakeEventsClient();
    await TestBed.configureTestingModule({
      imports: [ProjectTabsComponent],
      providers: [provideFakeEventsClient(events), provideRouter([])],
    }).compileComponents();
    // Subscribe the shell first (folds only see events after creation).
    const shell = TestBed.inject(ShellService);
    events.emit(projectCreated('P-1', 'alpha'));
    events.emit(projectCreated('P-2', 'beta'));
    shell.openProject('P-2');
  });

  function render(): ComponentFixture<ProjectTabsComponent> {
    const fixture = TestBed.createComponent(ProjectTabsComponent);
    fixture.autoDetectChanges();
    return fixture;
  }

  function el(fixture: ComponentFixture<ProjectTabsComponent>): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  it('renders one tab per open project, the active one marked', () => {
    const fixture = render();
    const names = [...el(fixture).querySelectorAll('.tab-name')].map((node) => node.textContent?.trim());
    expect(names).toEqual(['alpha', 'beta']);

    const active = el(fixture).querySelector('.project-tab.active .tab-name')?.textContent?.trim();
    expect(active).toBe('beta');
  });

  it('clicking a tab navigates to its workspace and activates it', async () => {
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    const fixture = render();
    (el(fixture).querySelectorAll<HTMLElement>('.project-tab')[0]!).click();
    await fixture.whenStable();

    expect(navigate).toHaveBeenCalledWith('/projects/P-1/coding/board');
    expect(TestBed.inject(ShellService).activeTabId()).toBe('P-1');
  });

  it('closing the active tab navigates to the last remaining one and removes the tab', async () => {
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    const fixture = render();
    el(fixture).querySelectorAll<HTMLButtonElement>('.tab-close')[1]!.click();
    await fixture.whenStable();

    expect(navigate).toHaveBeenCalledWith('/projects/P-1/coding/board');
    const shell = TestBed.inject(ShellService);
    expect(shell.openTabs().map((t) => t.id)).toEqual(['P-1']);
    expect(shell.activeTabId()).toBe('P-1');
  });

  it('a declined close (guard) rolls back and keeps the tab', async () => {
    const router = TestBed.inject(Router);
    vi.spyOn(router, 'navigateByUrl').mockRejectedValue(false);
    const fixture = render();
    el(fixture).querySelectorAll<HTMLButtonElement>('.tab-close')[1]!.click();
    await fixture.whenStable();

    const shell = TestBed.inject(ShellService);
    expect(shell.openTabs().map((t) => t.id)).toEqual(['P-1', 'P-2']);
    expect(shell.activeTabId()).toBe('P-2');
  });

  it('closing an inactive tab drops it without navigating or changing the active one', async () => {
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    const fixture = render();
    (el(fixture).querySelectorAll<HTMLElement>('.tab-close')[0]!).click();
    await fixture.whenStable();

    expect(navigate).not.toHaveBeenCalled();
    const shell = TestBed.inject(ShellService);
    expect(shell.openTabs().map((t) => t.id)).toEqual(['P-2']);
    expect(shell.activeTabId()).toBe('P-2');
  });
});
