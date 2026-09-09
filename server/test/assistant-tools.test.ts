// The assistant's read tools: scope validation, composer state reads from
// the real fold, file containment/safety, bounded git runs, and the web
// fetch's guards — git and fetch are injected (no network, no repository).

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Bus } from '../src/bus.js';
import { Processor } from '../src/processor/index.js';
import {
  executeAssistantTool,
  isPublicAddress,
  type AssistantToolEnv,
} from '../src/tools/assistant/index.js';
import type { EventFrame } from '../src/wire/envelope.js';

let dir: string;
let store: InstanceType<typeof import('../src/store/index.js').EventStore>;
let bus: Bus;
let processor: Processor;
let projectsCreated = 0;
const recorded: EventFrame[] = [];

/** The project's on-disk fixture: src/app.ts, src/deep/, data.bin, a link out. */
function makeProjectFiles(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# alpha\n');
  writeFileSync(join(root, 'src', 'app.ts'), 'export const answer = 42;\n');
  writeFileSync(join(root, 'docs', 'notes.md'), 'notes\n');
  writeFileSync(join(root, 'data.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
}

beforeEach(async () => {
  recorded.length = 0;
  projectsCreated = 0;
  dir = mkdtempSync(join(tmpdir(), 'composer-atools-'));
  const { EventStore } = await import('../src/store/index.js');
  store = new EventStore();
  await store.connect(dir);
  bus = new Bus(store);
  processor = new Processor(bus);
  bus.subscribe((frame) => recorded.push(frame));
});

afterEach(async () => {
  try {
    await store.close();
  } catch {
    // Already closed.
  }
  rmSync(dir, { recursive: true, force: true });
});

async function createProject(name: string, directory?: string): Promise<string> {
  const result = await processor.execute(undefined, {
    type: 'requestProjectCreate',
    name,
    ...(directory !== undefined ? { directory } : {}),
  });
  if (!result.ok) throw new Error(result.rejection.message);
  projectsCreated += 1;
  const id = `P-${projectsCreated}`;
  makeProjectFiles(join(dir, `project-${id}`));
  await processor.execute(id, {
    type: 'requestProjectSetDirectory',
    projectId: id,
    directory: join(dir, `project-${id}`),
  });
  return id;
}

async function createThread(scope: string[]): Promise<string> {
  await processor.execute(undefined, { type: 'requestAssistantThreadCreate', name: 't' });
  await processor.execute(undefined, {
    type: 'requestAssistantThreadScope',
    threadId: 'TH-1',
    projectIds: scope,
  });
  return 'TH-1';
}

function tools(): AssistantToolEnv {
  return { state: bus.state };
}

async function call(
  threadId: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  return executeAssistantTool(tools(), threadId, name, args);
}

// ---- Scope ----

describe('tool scope', () => {
  it('unknown threads reject every tool', async () => {
    const result = await call('TH-9', 'composer_overview');
    expect(result).toEqual({ ok: false, error: 'unknown thread TH-9' });
  });

  it('a project outside the thread scope rejects', async () => {
    const alpha = await createProject('alpha');
    const beta = await createProject('beta');
    const id = await createThread([alpha]);
    expect(await call(id, 'composer_overview', { projectId: beta })).toEqual({
      ok: false,
      error: `project ${beta} is not in this thread's scope`,
    });
    expect(await call(id, 'read_file', { projectId: beta, path: 'README.md' })).toMatchObject({
      ok: false,
    });
  });

  it('an empty scope has nothing to read', async () => {
    const id = await createThread([]);
    expect(await call(id, 'composer_overview')).toEqual({
      ok: false,
      error: 'the thread has no projects in scope',
    });
  });
});

// ---- Composer state reads ----

describe('composer state reads', () => {
  it('the overview folds cards, runs, and sessions per project (and the portfolio)', async () => {
    const alpha = await createProject('alpha');
    const beta = await createProject('beta');
    const id = await createThread([alpha, beta]);

    await processor.execute(alpha, {
      type: 'requestCardCreate',
      card: { id: '', projectId: alpha, type: 'coding', title: 'Ship it', description: '', tags: [], pipelineId: '', stepId: '', blockedBy: [], stepStates: {}, createdAt: '', updatedAt: '' },
    });
    await bus.publish(alpha, 'pipelineRunStarted', {
      runId: 'R-1',
      cardId: 'T-1',
      pipelineId: 'PL-1',
      revision: 1,
    });
    await bus.publish(alpha, 'pipelineRunEnded', {
      runId: 'R-1',
      cardId: 'T-1',
      pipelineId: 'PL-1',
      revision: 1,
      status: 'failed',
      error: 'tests red',
    });

    const single = JSON.parse((await call(id, 'composer_overview', { projectId: alpha })).content as string);
    expect(single.cards).toEqual({ total: 1, byStep: { 'st-1': 1 } });
    expect(single.latestRuns).toEqual([expect.objectContaining({ status: 'failed', error: 'tests red' })]);

    const portfolio = JSON.parse((await call(id, 'composer_overview')).content as string);
    expect(portfolio.map((entry: { project: { id: string } }) => entry.project.id)).toEqual([alpha, beta]);
  });

  it('composer_card returns the card with its latest run', async () => {
    const alpha = await createProject('alpha');
    const id = await createThread([alpha]);
    await processor.execute(alpha, {
      type: 'requestCardCreate',
      card: { id: '', projectId: alpha, type: 'coding', title: 'Ship it', description: 'the work', tags: [], pipelineId: '', stepId: '', blockedBy: [], stepStates: {}, createdAt: '', updatedAt: '' },
    });
    const detail = JSON.parse((await call(id, 'composer_card', { projectId: alpha, cardId: 'T-1' })).content as string);
    expect(detail).toMatchObject({ id: 'T-1', title: 'Ship it', description: 'the work' });
    expect(await call(id, 'composer_card', { projectId: alpha, cardId: 'T-99' })).toEqual({
      ok: false,
      error: 'unknown card T-99',
    });
  });

  it('composer_plan reads the latest (or named) session document', async () => {
    const alpha = await createProject('alpha');
    const id = await createThread([alpha]);
    await processor.execute(alpha, { type: 'requestPlanningSessionCreate', projectId: alpha });
    await processor.execute(alpha, {
      type: 'requestPlanDocumentUpdate',
      sessionId: 'S-1',
      document: '<plan><goal>v1</goal></plan>',
    });

    const latest = JSON.parse((await call(id, 'composer_plan', { projectId: alpha })).content as string);
    expect(latest).toMatchObject({ id: 'S-1', planDocument: '<plan><goal>v1</goal></plan>' });
    expect(await call(id, 'composer_plan', { projectId: alpha, sessionId: 'S-9' })).toEqual({
      ok: false,
      error: 'unknown session S-9',
    });
  });
});

// ---- File tools ----

describe('file tools', () => {
  it('list_files enumerates one level with kinds and sizes', async () => {
    const alpha = await createProject('alpha');
    const id = await createThread([alpha]);
    const listing = JSON.parse((await call(id, 'list_files', { projectId: alpha })).content as string);
    const names = listing.entries.map((entry: { name: string }) => entry.name);
    expect(names).toEqual(expect.arrayContaining(['README.md', 'src', 'docs', 'data.bin']));
    const readme = listing.entries.find((entry: { name: string }) => entry.name === 'README.md');
    expect(readme).toMatchObject({ kind: 'file', size: expect.any(Number) });
  });

  it('read_file returns bounded text and detects binary', async () => {
    const alpha = await createProject('alpha');
    const id = await createThread([alpha]);
    const text = JSON.parse((await call(id, 'read_file', { projectId: alpha, path: 'src/app.ts' })).content as string);
    expect(text).toMatchObject({ text: 'export const answer = 42;\n', truncated: false });
    const binary = JSON.parse((await call(id, 'read_file', { projectId: alpha, path: 'data.bin' })).content as string);
    expect(binary.binary).toBe(true);
    expect(binary.text).toBeUndefined();
  });

  it('a read past the cap truncates', async () => {
    const alpha = await createProject('alpha');
    const id = await createThread([alpha]);
    writeFileSync(join(dir, `project-${alpha}`, 'big.txt'), 'x'.repeat(70 * 1024));
    const result = JSON.parse((await call(id, 'read_file', { projectId: alpha, path: 'big.txt' })).content as string);
    expect(result.truncated).toBe(true);
    expect(result.size).toBe(70 * 1024);
  });

  it('paths cannot escape the project directory — not even via symlinks', async () => {
    const alpha = await createProject('alpha');
    const id = await createThread([alpha]);
    const outside = join(dir, 'outside.txt');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(dir, `project-${alpha}`, 'escape.lnk'));
    symlinkSync(dir, join(dir, `project-${alpha}`, 'dir-escape.lnk'));

    expect(await call(id, 'read_file', { projectId: alpha, path: '../outside.txt' })).toEqual({
      ok: false,
      error: 'path escapes the project directory',
    });
    expect(await call(id, 'read_file', { projectId: alpha, path: 'escape.lnk' })).toEqual({
      ok: false,
      error: 'path escapes the project directory',
    });
    expect(await call(id, 'list_files', { projectId: alpha, path: 'dir-escape.lnk' })).toMatchObject({
      ok: false,
    });
  });

  it('a project without a directory rejects file tools', async () => {
    const result = await processor.execute(undefined, { type: 'requestProjectCreate', name: 'bare' });
    expect(result.ok).toBe(true);
    projectsCreated += 1;
    const bare = `P-${projectsCreated}`;
    const id = await createThread([bare]);
    expect(await call(id, 'read_file', { projectId: bare, path: 'README.md' })).toEqual({
      ok: false,
      error: `project ${bare} has no directory set`,
    });
  });
});

// ---- Git tools (injected runner) ----

describe('git tools', () => {
  function gitEnv(output: string, calls: { directory: string; args: string[] }[] = []): AssistantToolEnv {
    return {
      state: bus.state,
      git: async (directory, args) => {
        calls.push({ directory, args });
        return output;
      },
    };
  }

  async function callWith(env: AssistantToolEnv, name: string, args: Record<string, unknown>) {
    return executeAssistantTool(env, 'TH-1', name, args);
  }

  it('git_log bounds the count and parses commits', async () => {
    const alpha = await createProject('alpha');
    await createThread([alpha]);
    const calls: { directory: string; args: string[] }[] = [];
    const env = gitEnv('a1b2c3d\x00ship it\x002026-09-06T00:00:00Z\n', calls);
    const result = JSON.parse((await callWith(env, 'git_log', { projectId: alpha, limit: 3 })).content as string);
    expect(result.commits).toEqual([{ hash: 'a1b2c3d', subject: 'ship it', at: '2026-09-06T00:00:00Z' }]);
    expect(calls[0]?.args).toEqual(['log', '--max-count=3', '--format=%h%x00%s%x00%cI']);
    // The count clamps to the cap.
    await callWith(gitEnv('', calls), 'git_log', { projectId: alpha, limit: 999 });
    expect(calls[1]?.args).toEqual(['log', '--max-count=20', '--format=%h%x00%s%x00%cI']);
  });

  it('git_diff passes the path filter and caps the output', async () => {
    const alpha = await createProject('alpha');
    await createThread([alpha]);
    const calls: { directory: string; args: string[] }[] = [];
    const env = gitEnv('diff --git a/src/app.ts ...', calls);
    const result = JSON.parse(
      (await callWith(env, 'git_diff', { projectId: alpha, path: 'src/app.ts' })).content as string,
    );
    expect(result.diff).toContain('diff --git');
    expect(calls[0]?.args).toEqual(['diff', '--no-color', '--', 'src/app.ts']);

    const long = 'z'.repeat(20 * 1024);
    const capped = JSON.parse(
      (await callWith(gitEnv(long, calls), 'git_diff', { projectId: alpha })).content as string,
    );
    expect(capped.truncated).toBe(true);
    expect(capped.diff.length).toBe(16 * 1024);
  });

  it('a git failure is a tool error, not a throw', async () => {
    const alpha = await createProject('alpha');
    await createThread([alpha]);
    const env: AssistantToolEnv = {
      state: bus.state,
      git: async () => {
        throw new Error('fatal: not a git repository');
      },
    };
    expect(await callWith(env, 'git_log', { projectId: alpha })).toMatchObject({
      ok: false,
      error: expect.stringContaining('git failed'),
    });
  });
});

// ---- web_fetch (injected fetch + resolver) ----

describe('web_fetch', () => {
  const PUBLIC = ['93.184.216.34'];
  const PRIVATE = ['127.0.0.1'];

  function webEnv(
    responses: Response[],
    addresses: string[] = PUBLIC,
    calls: { url: URL; init?: RequestInit }[] = [],
  ): AssistantToolEnv {
    return {
      state: bus.state,
      resolveHost: async () => addresses,
      fetchPage: (async (url: URL, init?: RequestInit) => {
        calls.push({ url, init });
        const next = responses.shift();
        if (next === undefined) throw new Error('no scripted response');
        return next;
      }) as typeof fetch,
    };
  }

  async function callWeb(env: AssistantToolEnv, url: string) {
    return executeAssistantTool(env, 'TH-1', 'web_fetch', { url });
  }

  it('fetches an https text document', async () => {
    await createThread([]);
    const env = webEnv([new Response('<html>docs</html>', { status: 200, headers: { 'content-type': 'text/html' } })]);
    const result = JSON.parse((await callWeb(env, 'https://example.com/docs')).content as string);
    expect(result).toMatchObject({ status: 200, contentType: 'text/html', text: '<html>docs</html>' });
    expect(result.url).toBe('https://example.com/docs');
  });

  it('rejects non-https urls and private hosts', async () => {
    await createThread([]);
    expect(await callWeb(webEnv([]), 'http://example.com')).toEqual({
      ok: false,
      error: 'only https urls are fetched',
    });
    expect(await callWeb(webEnv([], PRIVATE), 'https://localhost/docs')).toMatchObject({
      ok: false,
      error: expect.stringContaining('not reachable'),
    });
  });

  it('follows https redirects but never into private hosts or plain http', async () => {
    await createThread([]);
    const calls: { url: URL }[] = [];
    const env = webEnv(
      [
        new Response(null, { status: 302, headers: { location: 'https://example.com/v2' } }),
        new Response('found', { status: 200, headers: { 'content-type': 'text/plain' } }),
      ],
      PUBLIC,
      calls,
    );
    const result = JSON.parse((await callWeb(env, 'https://example.com/a')).content as string);
    expect(result.text).toBe('found');
    expect(calls.map(({ url }) => url.toString())).toEqual([
      'https://example.com/a',
      'https://example.com/v2',
    ]);

    const toPrivate = webEnv(
      [new Response(null, { status: 301, headers: { location: 'https://intranet.local/x' } })],
      PUBLIC,
    );
    // The redirect hop resolves private.
    const rejected = await callWeb(
      {
        ...toPrivate,
        resolveHost: async (host) => (host === 'intranet.local' ? PRIVATE : PUBLIC),
      },
      'https://example.com/a',
    );
    expect(rejected).toMatchObject({ ok: false, error: expect.stringContaining('not reachable') });

    const toHttp = webEnv([new Response(null, { status: 301, headers: { location: 'http://example.com/x' } })]);
    expect(await callWeb(toHttp, 'https://example.com/a')).toEqual({
      ok: false,
      error: 'redirect left https',
    });
  });

  it('rejects non-text content types and caps the body', async () => {
    await createThread([]);
    const zip = webEnv([new Response('bytes', { status: 200, headers: { 'content-type': 'application/zip' } })]);
    expect(await callWeb(zip, 'https://example.com/f.zip')).toMatchObject({
      ok: false,
      error: expect.stringContaining('unsupported content-type'),
    });

    const big = 'y'.repeat(300 * 1024);
    const capped = webEnv([new Response(big, { status: 200, headers: { 'content-type': 'text/plain' } })]);
    const result = JSON.parse((await callWeb(capped, 'https://example.com/big')).content as string);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(256 * 1024);
  });

  it('a fetch failure is a tool error', async () => {
    await createThread([]);
    const env: AssistantToolEnv = {
      state: bus.state,
      resolveHost: async () => PUBLIC,
      fetchPage: (async () => {
        throw new TypeError('connection refused');
      }) as typeof fetch,
    };
    expect(await callWeb(env, 'https://example.com/')).toMatchObject({
      ok: false,
      error: expect.stringContaining('fetch failed'),
    });
  });
});

// ---- The public-address guard itself ----

describe('isPublicAddress', () => {
  it('accepts public addresses and rejects private ranges', () => {
    expect(isPublicAddress('93.184.216.34')).toBe(true);
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('127.0.0.1')).toBe(false);
    expect(isPublicAddress('10.0.0.5')).toBe(false);
    expect(isPublicAddress('172.16.0.1')).toBe(false);
    expect(isPublicAddress('172.32.0.1')).toBe(true);
    expect(isPublicAddress('192.168.1.1')).toBe(false);
    expect(isPublicAddress('169.254.1.1')).toBe(false);
    expect(isPublicAddress('100.64.0.1')).toBe(false);
    expect(isPublicAddress('::1')).toBe(false);
    expect(isPublicAddress('fe80::1')).toBe(false);
    expect(isPublicAddress('fd00::1')).toBe(false);
    expect(isPublicAddress('::ffff:127.0.0.1')).toBe(false);
    expect(isPublicAddress('2606:4700::1')).toBe(true);
  });
});
