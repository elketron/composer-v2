import { computed, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';

import { DashboardService } from '../../dashboard/dashboard.service';
import { ShellService } from '../../shell/shell.service';
import { ConfirmService } from '../confirm/confirm.service';

/**
 * One executable palette entry. `run` performs the action (navigation or
 * command); the palette closes around it.
 */
export interface PaletteItem {
  id: string;
  label: string;
  /** Right-aligned context (project name, view kind). */
  hint?: string;
  /** Extra match text beyond the label. */
  keywords?: string;
  run: () => void | Promise<void>;
}

/**
 * The global command palette (Ctrl/Cmd+K): keyboard-first navigation and
 * quick actions across the shell. Items are rebuilt from shell state, so
 * projects appear (and disappear on archive) without extra wiring.
 */
@Injectable({ providedIn: 'root' })
export class PaletteService {
  private readonly shell = inject(ShellService);
  private readonly dashboard = inject(DashboardService);
  private readonly confirm = inject(ConfirmService);
  private readonly router = inject(Router);

  readonly isOpen = signal(false);
  readonly query = signal('');
  readonly activeIndex = signal(0);

  readonly items = computed<readonly PaletteItem[]>(() => {
    const items: PaletteItem[] = [
      {
        id: 'nav-dashboard',
        label: 'go to projects',
        hint: 'dashboard',
        keywords: 'dashboard home projects workspace',
        run: () => void this.navigate('/dashboard'),
      },
      {
        id: 'nav-settings',
        label: 'open settings',
        hint: 'settings',
        keywords: 'settings model preferences',
        run: () => void this.navigate('/settings'),
      },
    ];
    for (const project of this.shell.activeProjects()) {
      const base = `/projects/${encodeURIComponent(project.id)}/coding`;
      items.push({
        id: `project-${project.id}`,
        label: `open ${project.name}`,
        hint: project.directory ?? undefined,
        keywords: 'project open workspace',
        run: () => void this.navigate(this.shell.workspaceUrl(project.id)),
      });
      for (const [view, keywords] of PALETTE_VIEWS) {
        items.push({
          id: `project-${project.id}-${view}`,
          label: `${project.name} · ${view}`,
          hint: view,
          keywords: `project view ${keywords}`,
          run: () => void this.navigate(`${base}/${view}`),
        });
      }
      items.push({
        id: `archive-${project.id}`,
        label: `archive ${project.name}`,
        hint: 'action',
        keywords: 'project archive remove hide',
        run: async () => {
          const confirmed = await this.confirm.confirm({
            title: `Archive ${project.name}?`,
            detail: 'Its Composer history and linked directory will be preserved.',
            confirmLabel: 'archive',
            danger: true,
          });
          if (!confirmed) return;
          await this.shell.archiveProject(project.id);
        },
      });
    }
    items.push(
      {
        id: 'action-new-project',
        label: 'new project',
        hint: 'action',
        keywords: 'create project add directory',
        run: () => void this.shell.addTab(),
      },
      {
        id: 'action-refresh-health',
        label: 'refresh project health',
        hint: 'action',
        keywords: 'refresh reload git status health dashboard',
        run: () => void this.dashboard.refresh(),
      },
    );
    return items;
  });

  /** The query-matched items, best match first. */
  readonly results = computed<readonly PaletteItem[]>(() => {
    const needle = this.query().trim().toLowerCase();
    const items = this.items();
    if (needle === '') return items;
    const ranked: Array<{ item: PaletteItem; score: number }> = [];
    for (const item of items) {
      const label = item.label.toLowerCase();
      const haystack = `${label} ${item.keywords ?? ''}`;
      let score = -1;
      if (label.startsWith(needle)) score = 0;
      else if (label.split(' ').some((word) => word.startsWith(needle)))
        score = 1;
      else if (haystack.includes(needle)) score = 2;
      else if (subsequence(needle, haystack)) score = 3;
      if (score >= 0) ranked.push({ item, score });
    }
    return ranked.sort((a, b) => a.score - b.score).map(({ item }) => item);
  });

  openPalette(): void {
    this.query.set('');
    this.activeIndex.set(0);
    this.isOpen.set(true);
  }

  close(): void {
    this.isOpen.set(false);
  }

  toggle(): void {
    this.isOpen() ? this.close() : this.openPalette();
  }

  setQuery(query: string): void {
    this.query.set(query);
    this.activeIndex.set(0);
  }

  move(delta: number): void {
    const count = this.results().length;
    if (count === 0) return;
    this.activeIndex.update((index) => (index + delta + count) % count);
  }

  /** Runs the entry at `index` (default: the active one). */
  async executeAt(index: number = this.activeIndex()): Promise<void> {
    const item = this.results()[index];
    if (item === undefined) return;
    this.close();
    await item.run();
  }

  private async navigate(url: string): Promise<void> {
    await this.router.navigateByUrl(url);
  }
}

/** `needle`'s characters appear in `haystack` in order. */
function subsequence(needle: string, haystack: string): boolean {
  let at = 0;
  for (const char of needle) {
    at = haystack.indexOf(char, at);
    if (at < 0) return false;
    at += 1;
  }
  return true;
}

const PALETTE_VIEWS: ReadonlyArray<[view: string, keywords: string]> = [
  ['board', 'board kanban cards swimlanes'],
  ['plan', 'plan planner document chat'],
  ['pipelines', 'pipelines editor workflow steps'],
  ['coding', 'coding sessions agent transcript'],
];
