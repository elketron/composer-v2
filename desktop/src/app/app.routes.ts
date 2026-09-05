import { Routes } from '@angular/router';

import { BoardComponent } from './board/board.component';
import { PlanComponent } from './plan/plan.component';
import { SettingsComponent } from './settings/settings.component';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'board' },
  { path: 'board', component: BoardComponent },
  { path: 'plan', component: PlanComponent },
  { path: 'settings', component: SettingsComponent },
  { path: '**', redirectTo: 'board' },
];
