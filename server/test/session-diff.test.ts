// The agent-session diff route, end to end: a fake-engine run publishes
// the turn's edited files (the runner fills their stats from git), and
// GET /sessions/:id/diff computes the working-tree patches from the
// project's repository — modified tracked files diff against HEAD,
// untracked files synthesize an added-file diff.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boot } from '../src/index.js';
import { FakeEngine } from '../src/engine/fake.js';
import type { ComposerCaller } from '../src/agents/planner/index.js';

let dir: string;
let repo: string;
let server: Awaited<ReturnType<typeof boot>>;
let engine: FakeEngine | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'composer-diff-'));
  repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  git('init');
  git('-c', 'user.email=test@test', '-c', 'user.name=test', 'commit', '--allow-empty', '-m', 'init');
  writeFileSync(join(repo, 'a.ts'), 'line one\nline two\nline three\n');
  git('add', '.');
  git('-c', 'user.email=test@test', '-c', 'user.name=test', 'commit', '-m', 'a.ts');

  server = await boot({
    addr: '127.0.0.1:0',
    dataDir: join(dir, 'data'),
    engineFactory: (caller: ComposerCaller) => {
      engine = new FakeEngine(caller);
      return engine;
    },
  });
});

afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function action(body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${server.url}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
}

interface DiffFile {
  path: string;
  patch: string;
}

async function fetchDiff(): Promise<{ status: number; files?: DiffFile[] } | undefined> {
  const response = await fetch(`${server.url}/sessions/A-1/diff?projectId=P-1`);
  if (response.status === 404) return undefined;
  return { status: response.status, files: ((await response.json()) as { files: DiffFile[] }).files };
}

describe('GET /sessions/:sessionId/diff', () => {
  it('computes_working_tree_patches_for_the_session_s_edited_files', { timeout: 30_000 }, async () => {
    const created = await action({ type: 'create', on: 'project', projectId: '', body: { name: 'diff', directory: repo } });
    expect(created).toMatchObject({ ok: true });
    await action({ type: 'create', on: 'card', projectId: 'P-1', body: { title: 'edit things', type: 'coding' } });
    const saved = await action({
      type: 'create',
      on: 'pipeline',
      projectId: 'P-1',
      body: {
        name: 'one agent',
        lanes: [
          { id: 'ln-1', label: 'work', kanbanVisible: true },
          { id: 'ln-2', label: 'done', kanbanVisible: true, terminal: true },
        ],
        steps: [{ id: 'st-1', kind: 'agent', laneId: 'ln-1', agentKind: 'coder' }],
      },
    });
    expect(saved).toMatchObject({ ok: true });
    const pipelineId = saved['pipelineId'] as string;
    await action({ type: 'update', on: 'card', projectId: 'P-1', body: { id: 'T-1', pipelineId } });

    // The scripted turn edits a tracked file and adds an untracked one;
    // the engine names the paths (stats zeroed — the runner's git fills).
    engine!.enqueue(async ({ emit }) => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(repo, 'a.ts'), 'line one\nCHANGED\nline three\n');
      await writeFile(join(repo, 'new.ts'), 'brand new\n');
      emit({ kind: 'messageDelta', messageId: 'm1', delta: 'working ' });
      emit({ kind: 'files', files: [{ path: 'a.ts', additions: 0, deletions: 0 }, { path: 'new.ts', additions: 0, deletions: 0 }] });
      return 'edited two files';
    });

    const started = await action({ type: 'start', on: 'pipeline', projectId: 'P-1', body: { cardId: 'T-1' } });
    expect(started).toMatchObject({ ok: true });

    // The session appears once the agent step starts; the diff is ready
    // once the turn's (enriched) file observation landed.
    let diff: Awaited<ReturnType<typeof fetchDiff>> | undefined;
    for (let i = 0; i < 2000; i++) {
      diff = await fetchDiff();
      if (diff !== undefined && diff.files !== undefined && diff.files.length === 2 && diff.files.every((file) => file.patch !== '')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(diff).toBeDefined();
    expect(diff!.files).toHaveLength(2);

    const modified = diff!.files!.find((file) => file.path === 'a.ts');
    expect(modified?.patch).toContain('-line two');
    expect(modified?.patch).toContain('+CHANGED');

    const added = diff!.files!.find((file) => file.path === 'new.ts');
    expect(added?.patch).toContain('+brand new');
  });

  it('unknown_session_answers_404', async () => {
    const response = await fetch(`${server.url}/sessions/A-99/diff?projectId=P-1`);
    expect(response.status).toBe(404);
  });
});
