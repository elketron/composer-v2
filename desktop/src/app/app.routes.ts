import { CanDeactivateFn, Routes } from '@angular/router';
import { inject } from '@angular/core';

import { AssistantComponent } from './assistant/assistant.component';
import { BoardComponent } from './board/board.component';
import { DashboardComponent } from './dashboard/dashboard.component';
// Type-only: the docs view (and its CodeMirror editor) loads lazily —
// the editor would otherwise ride the initial bundle past its budget.
import type { DocsComponent } from './docs/docs.component';
import type { CanvasComponent } from './canvas/canvas.component';
import { PlanComponent } from './plan/plan.component';
import { CodingViewComponent } from './pipelines/coding-view.component';
import { RunViewComponent } from './run/run-view.component';
import { SettingsComponent } from './settings/settings.component';
import { ProjectWorkspaceComponent } from './shell/project-workspace.component';
import { ShellService } from './shell/shell.service';
import { KnowledgeService } from './knowledge/knowledge.service';

/**
 * Tabs keep detached project views alive, so leaving a view for another
 * tab (or another view of the same project) preserves its state — only
 * closing the tab drops it. The unsaved-work guards confirm exactly then.
 */
const onlyWhenClosingTab = (confirm: () => Promise<boolean>): Promise<boolean> => {
  if (!inject(ShellService).closingTab) return Promise.resolve(true);
  return confirm();
};

/** Leaving the docs view with unsaved edits confirms first (Phase 9). */
export const docsUnsavedGuard: CanDeactivateFn<DocsComponent> = (component) =>
  onlyWhenClosingTab(() => component.confirmLeave());

/** Leaving the canvas with unsaved diagram edits confirms first (Phase 11). */
export const canvasUnsavedGuard: CanDeactivateFn<CanvasComponent> = (component) =>
  onlyWhenClosingTab(() => component.confirmLeave());

/** Leaving the assistant with an unsaved knowledge note confirms first. */
export const knowledgeUnsavedGuard: CanDeactivateFn<AssistantComponent> = () => {
  const knowledge = inject(KnowledgeService);
  if (!knowledge.editingDirty()) return true;
  return knowledge.confirmDiscard();
};

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  { path: 'dashboard', component: DashboardComponent },
  {
    path: 'assistant',
    component: AssistantComponent,
    canDeactivate: [knowledgeUnsavedGuard],
  },
  {
    path: 'projects/:projectId/coding',
    component: ProjectWorkspaceComponent,
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'board' },
      { path: 'board', component: BoardComponent },
      { path: 'plan', component: PlanComponent },
      {
        path: 'pipelines',
        loadComponent: () =>
          import('./pipelines/pipeline-editor.component').then((module) => module.PipelineEditorComponent),
      },
      { path: 'coding', component: CodingViewComponent },
      {
        path: 'docs',
        loadComponent: () => import('./docs/docs.component').then((m) => m.DocsComponent),
        canDeactivate: [docsUnsavedGuard],
      },
      {
        path: 'canvas',
        loadComponent: () => import('./canvas/canvas.component').then((m) => m.CanvasComponent),
        canDeactivate: [canvasUnsavedGuard],
      },
      { path: 'run/:cardId', component: RunViewComponent },
      {
        // The read-only diff page (the run view's changed files link here);
        // lazy: diff2html would otherwise ride the initial bundle.
        path: 'run/:cardId/diff',
        loadComponent: () => import('./run/diff-view.component').then((m) => m.DiffViewComponent),
      },
      { path: '**', redirectTo: 'board' },
    ],
  },
  { path: 'settings', component: SettingsComponent },
  { path: '**', redirectTo: 'dashboard' },
];
