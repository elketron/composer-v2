import { Injectable } from '@angular/core';
import {
  ActivatedRouteSnapshot,
  BaseRouteReuseStrategy,
  DetachedRouteHandle,
} from '@angular/router';

/**
 * The project tabs' keep-alive (browser-tab semantics): every route under
 * `projects/:projectId/` detaches on leave and reattaches on return, so
 * each open project (and each of its views) keeps its live component
 * state — the canvas's working copy, the docs editor, scroll positions —
 * while another tab is on screen.
 *
 * Two rules make the detachment correct:
 * - `shouldReuseRoute` compares the route's params, so navigating between
 *   two projects (or two cards) never reuses one component instance for
 *   both — the old tree detaches instead.
 * - Handles are keyed by the URL path (no query), capped, and discarded
 *   when a tab closes or its project archives.
 */
@Injectable({ providedIn: 'root' })
export class ProjectTabReuseStrategy extends BaseRouteReuseStrategy {
  private static readonly CAP = 24;
  private readonly handlers = new Map<string, DetachedRouteHandle>();

  override shouldReuseRoute(future: ActivatedRouteSnapshot, curr: ActivatedRouteSnapshot): boolean {
    if (future.routeConfig !== curr.routeConfig) return false;
    // Different params = a different project/card/diagram: the old tree
    // must detach (keep its state), never be reused in place.
    return sameRecords(future.params, curr.params);
  }

  override shouldDetach(route: ActivatedRouteSnapshot): boolean {
    return this.isProjectRoute(route);
  }

  override store(snapshot: ActivatedRouteSnapshot, handle: DetachedRouteHandle | null): void {
    const key = this.key(snapshot);
    if (key === null) return;
    if (handle === null) {
      this.handlers.delete(key);
      return;
    }
    // Drop the oldest working state when the pool overflows (many views
    // visited across many tabs): the view rebuilds fresh on next visit.
    if (!this.handlers.has(key) && this.handlers.size >= ProjectTabReuseStrategy.CAP) {
      const oldest = this.handlers.keys().next().value;
      if (oldest !== undefined) this.handlers.delete(oldest);
    }
    this.handlers.set(key, handle);
  }

  override shouldAttach(route: ActivatedRouteSnapshot): boolean {
    const key = this.key(route);
    return key !== null && this.handlers.has(key);
  }

  override retrieve(route: ActivatedRouteSnapshot): DetachedRouteHandle | null {
    const key = this.key(route);
    return key === null ? null : (this.handlers.get(key) ?? null);
  }

  /**
   * Drops every stored view of one project (its tab closed, or the
   * project archived): the next visit starts fresh.
   */
  discard(projectId: string): void {
    const prefix = `projects/${projectId}/`;
    for (const key of [...this.handlers.keys()]) {
      if (key.startsWith(prefix)) this.handlers.delete(key);
    }
  }

  private isProjectRoute(route: ActivatedRouteSnapshot): boolean {
    return route.pathFromRoot.some(
      (candidate) => candidate.routeConfig?.path === 'projects/:projectId/coding',
    );
  }

  /** The handle key: the route's full path (`projects/P-1/coding/board`). */
  private key(route: ActivatedRouteSnapshot): string | null {
    const path = route.pathFromRoot
      .map((candidate) => candidate.url.map((segment) => segment.toString()).join('/'))
      .filter((part) => part !== '')
      .join('/');
    return path.startsWith('projects/') ? path : null;
  }
}

function sameRecords(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const a = Object.entries(left);
  const b = Object.entries(right);
  return a.length === b.length && a.every(([key, value]) => right[key] === value);
}
