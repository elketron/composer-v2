import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { dashboardProjects, readGitStatus, type GitRunner } from '../src/dashboard/index.js';
import { newState, type ProjectState } from '../src/fold/index.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'composer-dashboard-'));
  dirs.push(dir);
  return dir;
}

describe('Git dashboard status', () => {
  it('reads branch, clean state, and the latest commit', async () => {
    const dir = tempDir();
    const run: GitRunner = async (_directory, args) =>
      args[0] === 'status'
        ? '## main...origin/main\n'
        : 'abc123\u0000Ship dashboard\u00002026-09-06T04:00:00Z\n';

    await expect(readGitStatus(dir, run)).resolves.toEqual({
      status: 'clean',
      branch: 'main',
      latestCommit: { hash: 'abc123', subject: 'Ship dashboard', at: '2026-09-06T04:00:00Z' },
    });
  });

  it('reports dirty, missing, and non-repository directories', async () => {
    const dir = tempDir();
    const dirty: GitRunner = async (_directory, args) =>
      args[0] === 'status' ? '## feature/dashboard\n M src/app.ts\n?? notes.md\n' : '';
    expect(await readGitStatus(dir, dirty)).toMatchObject({ status: 'dirty', branch: 'feature/dashboard' });
    await expect(readGitStatus('/definitely/missing')).resolves.toEqual({ status: 'missing-directory' });
    await expect(
      readGitStatus(dir, async () => {
        throw new Error('fatal: not a git repository');
      }),
    ).resolves.toEqual({ status: 'not-repository' });
  });
});

describe('dashboard project aggregation', () => {
  it('returns active projects with actionable run health', async () => {
    const state = newState();
    state.projects.set('P-1', {
      id: 'P-1',
      name: 'alpha',
      directory: '/work/alpha',
      createdAt: '2026-09-06T01:00:00Z',
    });
    state.projects.set('P-2', {
      id: 'P-2',
      name: 'archived',
      createdAt: '2026-09-06T02:00:00Z',
      archivedAt: '2026-09-06T03:00:00Z',
    });
    state.byProject.set('P-1', projectState());

    const projects = await dashboardProjects(state, async () => ({ status: 'clean', branch: 'main' }));

    expect(projects).toEqual([
      expect.objectContaining({
        id: 'P-1',
        runningRuns: 1,
        waitingApprovals: [
          { runId: 'R-2', cardId: 'T-2', cardTitle: 'Approve me', pipelineId: 'PL-1' },
        ],
        failedRuns: [
          expect.objectContaining({ runId: 'R-3', cardId: 'T-3', cardTitle: 'Fix me', pipelineId: 'PL-1' }),
        ],
        git: { status: 'clean', branch: 'main' },
      }),
    ]);
  });
});

function projectState(): ProjectState {
  const run = (
    id: string,
    cardId: string,
    status: 'running' | 'waiting' | 'failed' | 'returned',
    startedAt: string,
    error?: string,
  ) => ({
    id,
    cardId,
    pipelineId: 'PL-1',
    revision: 1,
    status,
    startedAt,
    ...(status === 'running' || status === 'waiting' ? {} : { endedAt: '2026-09-06T01:01:00Z' }),
    ...(error !== undefined ? { error } : {}),
  });
  return {
    projectId: 'P-1',
    cards: new Map([
      ['T-1', card('T-1', 'Running')],
      ['T-2', card('T-2', 'Approve me')],
      ['T-3', card('T-3', 'Fix me')],
    ]),
    automation: new Map(),
    planningSessions: new Map(),
    agentSessions: new Map(),
    pipelines: new Map(),
    pipelineRevisions: new Map(),
    deletedPipelines: new Set(),
    runs: new Map([
      ['R-1', run('R-1', 'T-1', 'running', '2026-09-06T01:00:00Z')],
      ['R-2', run('R-2', 'T-2', 'waiting', '2026-09-06T01:00:00Z')],
      ['R-3', run('R-3', 'T-3', 'failed', '2026-09-06T01:00:00Z', 'tests failed')],
    ]),
    activeRuns: new Map([
      ['T-1', 'R-1'],
      ['T-2', 'R-2'],
    ]),
  };
}

function card(id: string, title: string) {
  return {
    id,
    projectId: 'P-1',
    type: 'coding' as const,
    title,
    description: '',
    tags: [],
    pipelineId: 'PL-1' as const,
    stageId: 'sg-2',
    blockedBy: [],
    stepStates: {},
    createdAt: '2026-09-06T01:00:00Z',
    updatedAt: '2026-09-06T01:00:00Z',
  };
}
