// The agent workflow domain (S34), end to end: a worker agent records a
// procedure through the /mcp/worker route (start → add_step → stop), the
// file lands under `.composer/workflows/`, the metadata event carries no
// content, the REST reads and search answer from disk, and the recording
// rules hold (session-bound, one per session, non-empty). The format
// round-trips are unit-tested below.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boot } from '../src/index.js';
import { FakeEngine } from '../src/engine/fake.js';
import { invalidWorkflowPath, parseWorkflow, serializeWorkflow } from '../src/workflows.js';

let dir: string;
let projectDir: string;
let server: Awaited<ReturnType<typeof boot>>;
/** Resolves the parked engine turn (the outcome e2e releases its reviewer). */
let releaseTurn: (() => void) | null = null;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'composer-workflows-'));
  projectDir = join(dir, 'project');
  mkdirSync(projectDir, { recursive: true });
  releaseTurn = null;
  server = await boot({
    addr: '127.0.0.1:0',
    dataDir: dir,
    // One parked coder turn: the run stays mid-step while the test drives
    // the recording tools against its session (and aborts cleanly on close).
    engineFactory: (processor) => {
      const engine = new FakeEngine(processor);
      engine.enqueue(({ spec }) => new Promise<string>((resolve) => {
        spec.signal?.addEventListener('abort', () => resolve('aborted'), { once: true });
        releaseTurn = () => resolve('done');
      }));
      return engine;
    },
  });
  const created = await action({
    type: 'create',
    on: 'project',
    body: { name: 'alpha', directory: projectDir },
  });
  expect(created.json).toEqual({ ok: true });
  expect(await action({ type: 'create', on: 'card', body: { title: 'wired', type: 'coding' } })).toEqual({
    status: 200,
    json: { ok: true },
  });
});

afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function action(body: unknown, projectId = 'P-1'): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${server.url}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, ...body }),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function get(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${server.url}${path}`);
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function worker(
  tool: string,
  args: Record<string, unknown> = {},
  sessionId = 'A-1',
  projectId = 'P-1',
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${server.url}/mcp/worker`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, sessionId, tool, args }),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

/** Runs the card's pipeline and waits until its agent session accepts recordings. */
async function startRun(): Promise<void> {
  expect(
    await action({ type: 'start', on: 'pipeline', body: { cardId: 'T-1' } }),
  ).toEqual({ status: 200, json: { ok: true } });
  for (let i = 0; i < 400; i++) {
    const started = await worker('workflow_start_recording', {
      title: 'probe',
    });
    if (started.json.ok === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the agent session never started');
}

describe('the workflow domain', () => {
  it('a_worker_records_a_procedure_and_the_file_is_the_truth', async () => {
    const stream = await openEventStream();
    await stream.next(); // attach proven: the first snapshot frame
    await startRun();

    expect(
      await worker('workflow_add_step', {
        step: { title: 'Scaffold the route file', detail: 'Keep handlers thin.', command: 'npm run generate route' },
      }),
    ).toEqual({ status: 200, json: { ok: true } });
    expect(
      await worker('workflow_add_step', { step: { title: 'Run the checks', command: 'npm test' } }),
    ).toEqual({ status: 200, json: { ok: true } });

    const stopped = await worker('workflow_stop_recording', {
      links: ['docs/api.md', 'card:T-3'],
    });
    expect(stopped.json).toMatchObject({ ok: true, savedPath: 'probe.md' });

    // The file carries the procedure: frontmatter plus the ordered steps.
    const onDisk = readFileSync(join(projectDir, '.composer', 'workflows', 'probe.md')).toString();
    expect(onDisk).toContain('title: probe');
    expect(onDisk).toContain('source: T-1');
    expect(onDisk).toContain('agent: coder');
    expect(onDisk).toContain('1. Scaffold the route file');
    expect(onDisk).toContain('!npm run generate route');
    expect(onDisk).toContain('links: docs/api.md, card:T-3');

    // The event carries metadata only — no step content.
    const saved = await stream.until((frame) => frame['eventType'] === 'workflowSaved');
    expect(saved).toBeDefined();
    const body = saved!['body'] as { workflow: Record<string, unknown> };
    expect(body.workflow).toMatchObject({ path: 'probe.md', title: 'probe', steps: 2, source: 'T-1' });
    expect(JSON.stringify(saved)).not.toContain('generate route');
  });

  it('list_read_and_search_answer_from_disk_over_rest', async () => {
    await startRun();
    await worker('workflow_add_step', { step: { title: 'Build the thing', command: 'npm run build' } });
    const stopped = await worker('workflow_stop_recording', {});
    expect(stopped.json).toMatchObject({ ok: true, savedPath: 'probe.md' });

    const list = await get('/projects/P-1/workflows');
    expect(list.json).toEqual({
      workflows: [expect.objectContaining({ path: 'probe.md', title: 'probe', steps: 1 })],
    });

    const read = await get('/projects/P-1/workflows/content?path=probe.md');
    expect(read.json.workflow).toMatchObject({ path: 'probe.md' });
    expect(read.json.workflow.content).toContain('!npm run build');

    const search = await get('/projects/P-1/workflows/search?q=build');
    expect(search.json.results).toEqual([
      expect.objectContaining({ path: 'probe.md', score: expect.any(Number) }),
    ]);
    expect(await get('/projects/P-1/workflows/search?q=nomatch')).toEqual({
      status: 200,
      json: { results: [] },
    });
  });

  it('recordings_are_session_bound_and_must_be_non_empty', async () => {
    // No session yet: every recording tool rejects.
    const orphan = await worker('workflow_start_recording', { title: 'x' }, 'A-99');
    expect(orphan.json).toMatchObject({ ok: false, error: expect.stringContaining('Unknown agent session') });

    await startRun();

    // Stopping with no steps rejects and keeps the recording open.
    const empty = await worker('workflow_stop_recording', {});
    expect(empty.json).toMatchObject({ ok: false, error: expect.stringContaining('at least one step') });

    // A second start for the same session rejects.
    const again = await worker('workflow_start_recording', { title: 'another' });
    expect(again.json).toMatchObject({
      ok: false,
      error: 'Session A-1 already has an open workflow recording',
    });

    // Adding a step after the failed stop lands in the original recording.
    expect(await worker('workflow_add_step', { step: { title: 'The one step' } })).toEqual({
      status: 200,
      json: { ok: true },
    });
    const stopped = await worker('workflow_stop_recording', {});
    expect(stopped.json).toMatchObject({ ok: true, savedPath: 'probe.md' });
  });

  it('malformed_calls_reject_and_delete_tombstones_through_the_action_route', async () => {
    const unknownTool = await worker('workflow_exec', {});
    expect(unknownTool.status).toBe(400);

    const noStep = await worker('workflow_add_step', { step: { title: '   ' } }, 'A-99');
    expect(noStep.json).toMatchObject({ ok: false });

    await startRun();
    await worker('workflow_add_step', { step: { title: 'Step', command: 'true' } });
    expect((await worker('workflow_stop_recording', {})).json).toMatchObject({ ok: true });

    const gone = await action({ type: 'delete', on: 'workflow', body: { path: 'probe.md' } });
    expect(gone.json).toEqual({ ok: true });
    expect(() => readFileSync(join(projectDir, '.composer', 'workflows', 'probe.md'))).toThrow();

    const missing = await action({ type: 'delete', on: 'workflow', body: { path: 'probe.md' } });
    expect(missing.json).toMatchObject({ ok: false, rejectionCode: 'invalidCommand' });
  });

  it('a_project_without_a_directory_has_no_workflow_surface', async () => {
    await action({ type: 'create', on: 'project', body: { name: 'bare' } });
    const list = await get('/projects/P-2/workflows');
    expect(list.json).toMatchObject({ error: expect.stringContaining('no directory') });
  });
});

describe('the outcome tool end to end', () => {
  it('reports_through_the_worker_route_and_returns_the_card', async () => {
    const stream = await openEventStream();
    await stream.next(); // attach proven: the first snapshot frame
    // A pipeline whose only agent step reviews at an outcome stage — the
    // boot's parked turn is the reviewer's, and its verdict routes the card.
    expect(
      await action({
        type: 'create',
        on: 'pipeline',
        body: {
          name: 'review only',
          stages: [
            { id: 'sg-1', label: 'New', kanbanVisible: true },
            {
              id: 'sg-2',
              label: 'Review',
              kanbanVisible: true,
              outcomes: [{ outcome: 'approved' }, { outcome: 'changes_requested', toStageId: 'sg-1' }],
              requiresOutcome: true,
            },
            { id: 'sg-3', label: 'Done', kanbanVisible: true, terminal: true },
          ],
          steps: [{ id: 'st-1', kind: 'agent', stageId: 'sg-2', agentKind: 'reviewer', instructions: 'Review the card.' }],
        },
      }),
    ).toEqual({ status: 200, json: { ok: true } });
    expect(
      await action({ type: 'update', on: 'card', body: { id: 'T-1', pipelineId: 'PL-2' } }),
    ).toEqual({ status: 200, json: { ok: true } });
    expect(await action({ type: 'start', on: 'pipeline', body: { cardId: 'T-1' } })).toEqual({
      status: 200,
      json: { ok: true },
    });

    // The reviewer reports through the real route (poll until its session
    // accepts tool calls, like startRun).
    let reported: Record<string, unknown> | undefined;
    for (let i = 0; i < 400; i++) {
      const attempt = await worker('report_outcome', { outcome: 'changes_requested', note: 'tests missing' });
      if (attempt.json.ok === true) {
        reported = attempt.json;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(reported).toMatchObject({
      ok: true,
      transition: 'the card returns to New when the step finishes',
    });

    // The turn finishes; the runner applies the outcome (move, then end).
    releaseTurn?.();
    const moved = await stream.until((frame) => frame['eventType'] === 'cardStageMoved');
    expect((moved?.['body'] as { toStageId: string }).toStageId).toBe('sg-1');
    const ended = await stream.until((frame) => frame['eventType'] === 'pipelineRunEnded');
    expect((ended?.['body'] as { status: string }).status).toBe('returned');
    expect((ended?.['body'] as { error?: string }).error).toBe('changes_requested: tests missing');
  });
});

describe('the workflow format', () => {
  it('serialize_and_parse_round_trip', () => {
    const raw = serializeWorkflow({
      title: 'Add an HTTP endpoint',
      description: 'The procedure for a new route.',
      tags: ['backend', 'http'],
      source: 'T-7',
      agent: 'coder',
      recordedAt: '2026-09-07T06:30:00.000Z',
      steps: [
        { title: 'Scaffold the route', detail: 'Keep handlers thin.\nRegister the route in the barrel.', command: 'npm run generate route' },
        { title: 'Write the test' },
        { title: 'Run the checks', command: 'npm test' },
      ],
      links: ['docs/api.md', 'knowledge:deploy-checklist', 'card:T-3'],
    });
    const parsed = parseWorkflow('add-an-http-endpoint.md', raw);
    expect(parsed.info).toMatchObject({
      title: 'Add an HTTP endpoint',
      description: 'The procedure for a new route.',
      tags: ['backend', 'http'],
      source: 'T-7',
      agent: 'coder',
      steps: 3,
      links: ['docs/api.md', 'knowledge:deploy-checklist', 'card:T-3'],
      recordedAt: '2026-09-07T06:30:00.000Z',
    });
    expect(parsed.steps).toEqual([
      { title: 'Scaffold the route', detail: 'Keep handlers thin.\nRegister the route in the barrel.', command: 'npm run generate route' },
      { title: 'Write the test' },
      { title: 'Run the checks', command: 'npm test' },
    ]);
  });

  it('human_edits_keep_reading', () => {
    const raw = [
      '---',
      'title: Hand edited',
      'tags: one, two',
      'links: docs/a.md',
      '---',
      '',
      'Free prose before the steps is ignored.',
      '',
      '## Steps',
      '',
      '1. First',
      '   detail line',
      '   !echo one',
      '   !echo two',
      '2. Second',
      '',
      'Trailing prose is ignored too.',
    ].join('\n');
    const parsed = parseWorkflow('hand-edited.md', raw);
    expect(parsed.info).toMatchObject({ title: 'Hand edited', tags: ['one', 'two'], links: ['docs/a.md'], steps: 2 });
    expect(parsed.steps).toEqual([
      { title: 'First', detail: 'detail line', command: 'echo one' },
      { title: 'Second' },
    ]);
  });

  it('invalidWorkflowPath_states_the_rule', () => {
    expect(invalidWorkflowPath('ok.md')).toBeNull();
    expect(invalidWorkflowPath('deep/ok.md')).toMatch(/plain file names/);
    expect(invalidWorkflowPath('../out.md')).toMatch(/plain file names/);
    expect(invalidWorkflowPath('a.txt')).toMatch(/\.md/);
  });
});

/** One open SSE connection read incrementally (attach → snapshot → live). */
async function openEventStream(): Promise<{
  next: () => Promise<Record<string, unknown>>;
  until: (predicate: (frame: Record<string, unknown>) => boolean) => Promise<Record<string, unknown> | undefined>;
}> {
  const response = await fetch(`${server.url}/events`);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const parse = (): Record<string, unknown>[] => {
    const frames: Record<string, unknown>[] = [];
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)));
    }
    return frames;
  };
  return {
    async next() {
      for (;;) {
        const [frame] = parse();
        if (frame !== undefined) return frame;
        const { done, value } = await reader.read();
        if (done) throw new Error('event stream ended');
        buffer += decoder.decode(value, { stream: true });
      }
    },
    async until(predicate) {
      for (let seen = 0; seen < 200; seen += 1) {
        const frame = parse().find(predicate);
        if (frame !== undefined) return frame;
        const { done, value } = await reader.read();
        if (done) return undefined;
        buffer += decoder.decode(value, { stream: true });
      }
      return undefined;
    },
  };
}
