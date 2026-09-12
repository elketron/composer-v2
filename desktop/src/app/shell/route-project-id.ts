import { inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

/**
 * The project id a routed component instance belongs to, read once from
 * the route tree (`projects/:projectId/...`). Under the tab reuse
 * strategy one instance always serves one project — a stable id, unlike
 * `shell.activeTabId()` which follows whichever tab is on screen.
 */
export function routedProjectId(route: ActivatedRoute = inject(ActivatedRoute)): string {
  for (let current: ActivatedRoute | null = route; current !== null; current = current.parent) {
    const id = current.snapshot.paramMap.get('projectId');
    if (id !== null && id !== '') return id;
  }
  return '';
}
