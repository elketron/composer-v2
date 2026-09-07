import { CanDeactivateFn, Routes } from '@angular/router';
import { inject } from '@angular/core';

import { AssistantComponent } from './assistant/assistant.component';
import { BoardComponent } from './board/board.component';
import { DashboardComponent } from './dashboard/dashboard.component';
// Type-only: the docs view (and its CodeMirror editor) loads lazily —
// the editor would otherwise ride the initial bundle past its budget.
import type { DocsComponent } from './docs/docs.component';
import { PlanComponent } from './plan/plan.component';
import { CodingViewComponent } from './pipelines/coding-view.component';
import { RunViewComponent } from './run/run-view.component';
import { SettingsComponent } from './settings/settings.component';
import { ProjectWorkspaceComponent } from './shell/project-workspace.component';
import { KnowledgeService } from './knowledge/knowledge.service';

/** Leaving the docs view with unsaved edits confirms first (Phase 9). */
export const docsUnsavedGuard: CanDeactivateFn<DocsComponent> = (component) =>
  component.confirmLeave();

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
      { path: 'run/:cardId', component: RunViewComponent },
      { path: '**', redirectTo: 'board' },
    ],
  },
  { path: 'settings', component: SettingsComponent },
  { path: '**', redirectTo: 'dashboard' },
];
