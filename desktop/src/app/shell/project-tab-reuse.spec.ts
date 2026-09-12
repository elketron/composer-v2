import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, UrlSegment } from '@angular/router';

import { ProjectTabReuseStrategy } from './project-tab-reuse';

/** A snapshot stub: only the pieces the strategy reads. */
function snapshot(path: string, params: Record<string, string> = {}): ActivatedRouteSnapshot {
  const segments = path.split('/').filter(Boolean).map((part) => new UrlSegment(part, {}));
  const fake = {
    routeConfig: { path: path === '' ? '' : path.split('/').join('/') },
    params,
    queryParams: {},
    url: segments,
    pathFromRoot: [] as ActivatedRouteSnapshot[],
  };
  // Build the pathFromRoot chain so `key()` can compute the full path.
  const parts = path.split('/').filter(Boolean);
  const configs = ['projects/:projectId/coding', 'board'];
  let accumulated = [] as ActivatedRouteSnapshot[];
  for (let index = 0; index < parts.length; index += 1) {
    const node = {
      routeConfig: {
        path: index === 1 ? 'projects/:projectId/coding' : parts[index],
      },
      params: index === 1 ? params : {},
      queryParams: {},
      url: [new UrlSegment(parts[index]!, {})],
      pathFromRoot: [],
    } as unknown as ActivatedRouteSnapshot;
    accumulated = [...accumulated, node];
    for (const entry of accumulated) {
      (entry as unknown as { pathFromRoot: ActivatedRouteSnapshot[] }).pathFromRoot = accumulated;
    }
  }
  void configs;
  return accumulated.at(-1)!;
}

describe('ProjectTabReuseStrategy', () => {
  let strategy: ProjectTabReuseStrategy;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    strategy = TestBed.inject(ProjectTabReuseStrategy);
  });

  it('detaches project routes and nothing else', () => {
    const board = snapshot('projects/P-1/coding/board');
    const dashboard = snapshot('dashboard');
    expect(strategy.shouldDetach(board)).toBe(true);
    expect(strategy.shouldDetach(dashboard)).toBe(false);
    expect(strategy.shouldAttach(dashboard)).toBe(false);
  });

  it('stores and reattaches per path', () => {
    const board = snapshot('projects/P-1/coding/board');
    expect(strategy.shouldAttach(board)).toBe(false);

    strategy.store(board, { restore: true } as never);
    expect(strategy.shouldAttach(board)).toBe(true);
    expect(strategy.retrieve(board)).toEqual({ restore: true });
  });

  it('discard drops one project\'s stored views and keeps the others', () => {
    const p1board = snapshot('projects/P-1/coding/board');
    const p1canvas = snapshot('projects/P-1/coding/canvas');
    const p2board = snapshot('projects/P-2/coding/board');
    strategy.store(p1board, { id: 'p1-board' } as never);
    strategy.store(p1canvas, { id: 'p1-canvas' } as never);
    strategy.store(p2board, { id: 'p2-board' } as never);

    strategy.discard('P-1');

    expect(strategy.retrieve(p1board)).toBeNull();
    expect(strategy.shouldAttach(p1canvas)).toBe(false);
    expect(strategy.retrieve(p2board)).toEqual({ id: 'p2-board' });
  });

  it('reuse: same config and params reuse; differing params (another project) do not', () => {
    const p1 = snapshot('projects/P-1/coding/board', { projectId: 'P-1' });
    const p1again = snapshot('projects/P-1/coding/board', { projectId: 'P-1' });
    const p2 = snapshot('projects/P-2/coding/board', { projectId: 'P-2' });
    const canvas = snapshot('projects/P-1/coding/canvas', { projectId: 'P-1' });

    expect(strategy.shouldReuseRoute(p1, p1)).toBe(true);
    expect(strategy.shouldReuseRoute(p1, p2)).toBe(false);
    // A different view of the same project is a different route config.
    expect(strategy.shouldReuseRoute(p1, canvas)).toBe(false);
  });

  it('the handle pool is capped (oldest evicted)', () => {
    const fill = (strategy as unknown as { handlers: Map<string, unknown> }).handlers;
    for (let n = 0; n < 30; n += 1) {
      strategy.store(snapshot(`projects/P${n}/coding/board`), { n } as never);
    }
    expect(fill.size).toBeLessThanOrEqual(24);
    // The oldest evicted, the newest kept.
    expect(fill.has('projects/P0/coding/board')).toBe(false);
    expect(fill.has('projects/P29/coding/board')).toBe(true);
  });
});
