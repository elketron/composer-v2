import { Routes } from '@angular/router';

import { BoardComponent } from './board/board.component';
import { DashboardComponent } from './dashboard/dashboard.component';
import { PlanComponent } from './plan/plan.component';
import { CodingViewComponent } from './pipelines/coding-view.component';
import { PipelineEditorComponent } from './pipelines/pipeline-editor.component';
import { RunViewComponent } from './run/run-view.component';
import { SettingsComponent } from './settings/settings.component';
import { ProjectWorkspaceComponent } from './shell/project-workspace.component';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  { path: 'dashboard', component: DashboardComponent },
  {
    path: 'projects/:projectId/coding',
    component: ProjectWorkspaceComponent,
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'board' },
      { path: 'board', component: BoardComponent },
      { path: 'plan', component: PlanComponent },
      { path: 'pipelines', component: PipelineEditorComponent },
      { path: 'coding', component: CodingViewComponent },
      { path: 'run/:cardId', component: RunViewComponent },
      { path: '**', redirectTo: 'board' },
    ],
  },
  { path: 'settings', component: SettingsComponent },
  { path: '**', redirectTo: 'dashboard' },
];
