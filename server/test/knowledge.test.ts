// The knowledge library (Phase 9), end to end: agent-style saves via the
// MCP tool (slugs, frontmatter, unique paths), desktop-style saves via
// the knowledge command (exact file), scored search over REST and MCP,
// tombstones — and the metadata-only events on the global stream.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boot } from '../src/index.js';

let dir: string;
let server: Awaited<ReturnType<typeof boot>>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'composer-knowledge-'));
  server = await boot({ addr: '127.0.0.1:0', dataDir: dir, assistantEnabled: false, plannerEnabled: false });
  // A thread for the MCP surface (tool calls carry the thread id).
  await action({ type: 'create', on: 'assistantThread', projectId: '', body: { name: 'notes' } });
});

afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function action(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${server.url}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function get(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${server.url}${path}`);
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function mcpRead(threadId: string, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${server.url}/mcp/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ threadId, tool, args }),
  });
  return (await response.json()) as Record<string, unknown>;
}

describe('the knowledge domain', () => {
  it('an_agent_save_builds_frontmatter_and_a_unique_slug', async () => {
    const first = await mcpRead('TH-1', 'knowledge_save', {
      title: 'Postgres conventions',
      tags: ['postgres', 'conventions'],
      content: 'Always use parameterized queries.',
    });
    expect(first).toEqual({ ok: true, savedPath: 'postgres-conventions.md' });

    // A second save with the same title never overwrites.
    const second = await mcpRead('TH-1', 'knowledge_save', {
      title: 'Postgres conventions',
      content: 'Backups nightly.',
    });
    expect(second).toEqual({ ok: true, savedPath: 'postgres-conventions-2.md' });

    const onDisk = readFileSync(join(dir, 'knowledge', 'postgres-conventions.md')).toString('utf8');
    expect(onDisk).toContain('title: Postgres conventions');
    expect(onDisk).toContain('tags: postgres, conventions');
    expect(onDisk).toContain('Always use parameterized queries.');

    // The tool result names the file; the search finds both notes.
    const search = (await mcpRead('TH-1', 'knowledge_search', { query: 'postgres' })) as {
      ok: boolean;
      content: string;
    };
    expect(search.ok).toBe(true);
    const parsed = JSON.parse(search.content) as { results: Array<{ path: string }> };
    expect(parsed.results.map((result) => result.path)).toEqual([
      'postgres-conventions.md',
      'postgres-conventions-2.md',
    ]);
  });

  it('the_desktop_save_writes_the_exact_file_and_the_tombstone_removes_it', async () => {
    const saved = await action({
      type: 'create',
      on: 'knowledge',
      body: { path: 'editing-notes.md', content: '---\ntitle: Editing notes\n---\n\nbody text\n' },
    });
    expect(saved.json).toEqual({ ok: true, savedPath: 'editing-notes.md' });

    const read = await get('/knowledge/content?path=editing-notes.md');
    expect(read.json).toMatchObject({
      entry: { path: 'editing-notes.md', title: 'Editing notes', content: '---\ntitle: Editing notes\n---\n\nbody text\n' },
    });

    expect(
      await action({ type: 'delete', on: 'knowledge', body: { path: 'editing-notes.md' } }),
    ).toEqual({ status: 200, json: { ok: true } });
    const gone = await get('/knowledge/content?path=editing-notes.md');
    expect(gone.json).toMatchObject({ error: expect.stringContaining('not a readable note') });
  });

  it('a_symlinked_file_cannot_redirect_a_knowledge_write', async () => {
    const outside = join(dir, 'outside.md');
    mkdirSync(join(dir, 'knowledge'));
    writeFileSync(outside, '# unchanged\n');
    symlinkSync(outside, join(dir, 'knowledge', 'linked.md'));

    const saved = await action({
      type: 'create',
      on: 'knowledge',
      body: { path: 'linked.md', content: '# overwritten\n' },
    });

    expect(saved.json).toMatchObject({ ok: false, rejectionCode: 'invalidCommand' });
    expect(readFileSync(outside, 'utf8')).toBe('# unchanged\n');
  });

  it('search_ranks_title_above_body_and_requires_every_token', async () => {
    await mcpRead('TH-1', 'knowledge_save', { title: 'Release pipeline', content: 'deploys run on fridays' });
    await mcpRead('TH-1', 'knowledge_save', { title: 'Review rules', tags: ['deploy'], content: 'two approvals required' });

    const list = (await get('/knowledge')) as { json: { entries: Array<{ path: string }> } };
    expect(list.json.entries.length).toBe(2);

    const titleHit = (await get('/knowledge/search?q=deploy%20fridays')) as {
      json: { results: Array<{ path: string; score: number }> };
    };
    expect(titleHit.json.results[0]!.path).toBe('release-pipeline.md');
    // AND semantics: 'fridays' lives only in the first note's body.
    expect(titleHit.json.results.map((result) => result.path)).toEqual(['release-pipeline.md']);

    const tagged = (await get('/knowledge/search?q=deploy')) as {
      json: { results: Array<{ path: string; snippet: string }> };
    };
    // Both match "deploy" — the tag match (3) outranks the body match (1).
    expect(tagged.json.results[0]!.path).toBe('review-rules.md');
    expect(tagged.json.results[0]!.snippet).toContain('approvals');
  });

  it('metadata_only_events_ride_the_global_stream', async () => {
    const stream = await openEventStream();
    await stream.next(); // attach proven
    await action({
      type: 'create',
      on: 'knowledge',
      body: { title: 'A secret note', content: 'the payload must never ride the log' },
    });
    const saved = await stream.until((frame) => frame['eventType'] === 'knowledgeSaved');
    expect(saved).toBeDefined();
    expect(saved!['projectId']).toBeUndefined(); // global event
    const body = saved!['body'] as { entry: Record<string, unknown> };
    expect(body.entry).toMatchObject({ path: 'a-secret-note.md', title: 'A secret note' });
    expect(JSON.stringify(saved)).not.toContain('payload must never ride');
  });

  it('paths_reject_traversal_subdirs_and_non_md', async () => {
    for (const path of ['../escape.md', 'sub/dir.md', 'notes.txt', 'C:/x.md', '']) {
      const saved = await action({
        type: 'create',
        on: 'knowledge',
        body: { path, content: 'x' },
      });
      expect(saved.json, path).toMatchObject({ ok: false, rejectionCode: 'invalidCommand' });
    }
    expect(readdirSync(dir).filter((name) => name.endsWith('.md'))).toEqual([]);
  });

  it('mcp_save_requires_a_real_thread', async () => {
    const result = await mcpRead('TH-99', 'knowledge_save', { title: 'x', content: 'y' });
    expect(result).toEqual({ ok: false, error: 'unknown thread TH-99' });
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
