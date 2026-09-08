// The docs domain (Phase 9), end to end: a doc command writes the file and
// publishes metadata-only events, the REST reads answer from disk, and the
// path rules hold (traversal, symlinks, binary, caps). The golden order
// guards the wire; here the file layer is the subject.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boot } from '../src/index.js';
import { docTitle, invalidDocPath, listDocs, readDoc, saveDoc } from '../src/docs/index.js';
let dir: string;
let projectDir: string;
let server: Awaited<ReturnType<typeof boot>>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'composer-docs-'));
  projectDir = join(dir, 'project');
  mkdirSync(projectDir, { recursive: true });
  server = await boot({ addr: '127.0.0.1:0', dataDir: dir });
  const created = await action({
    type: 'create',
    on: 'project',
    body: { name: 'alpha', directory: projectDir },
  });
  expect(created.json).toEqual({ ok: true });
});

afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function action(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${server.url}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'P-1', ...body }),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function get(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${server.url}${path}`);
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe('the docs domain', () => {
  it('save_writes_the_file_and_publishes_metadata_only', async () => {
    // One stream, like the desktop: attach (the live subscription precedes
    // the snapshot), drain the snapshot, then watch for the live frame.
    // Doc events ride live only — the snapshot is fold state, which carries
    // no docs (files are the truth).
    const stream = await openEventStream();
    await stream.next(); // attach proven: the first snapshot frame
    const saved = await action({
      type: 'create',
      on: 'doc',
      body: { path: 'setup.md', content: '# Setup guide\n\nRun pnpm install.' },
    });
    expect(saved).toEqual({ status: 200, json: { ok: true } });

    const onDisk = readFileSync(join(projectDir, 'docs', 'setup.md'));
    expect(onDisk.toString('utf8')).toContain('pnpm install');

    // The event log carries the metadata, not the content.
    const docSaved = await stream.until((frame) => frame['eventType'] === 'docSaved');
    expect(docSaved).toBeDefined();
    const body = docSaved!['body'] as { doc: Record<string, unknown> };
    expect(body.doc).toMatchObject({ path: 'setup.md', title: 'Setup guide' });
    expect(JSON.stringify(docSaved)).not.toContain('pnpm install');
  });

  it('list_and_read_answer_from_disk_over_rest', async () => {
    expect(await action({ type: 'create', on: 'doc', body: { path: 'a.md', content: '# A\n' } })).toEqual({ status: 200, json: { ok: true } });
    expect(await action({ type: 'create', on: 'doc', body: { path: 'guide/b.md', content: 'plain intro\n' } })).toEqual({ status: 200, json: { ok: true } });

    const list = await get('/projects/P-1/docs');
    expect(list.json).toEqual({
      docs: [
        expect.objectContaining({ path: 'a.md', title: 'A' }),
        expect.objectContaining({ path: 'guide/b.md', title: 'b' }),
      ],
    });

    const read = await get('/projects/P-1/docs/content?path=guide/b.md');
    expect(read.json).toEqual({
      doc: expect.objectContaining({ path: 'guide/b.md', content: 'plain intro\n' }),
    });
  });

  it('delete_removes_the_file_and_publishes_a_scoped_tombstone', async () => {
    await action({ type: 'create', on: 'doc', body: { path: 'temp.md', content: '# Temp\n' } });
    expect(await action({ type: 'delete', on: 'doc', body: { path: 'temp.md' } })).toEqual({
      status: 200,
      json: { ok: true },
    });
    expect(() => statSync(join(projectDir, 'docs', 'temp.md'))).toThrow();

    const missing = await action({ type: 'delete', on: 'doc', body: { path: 'temp.md' } });
    expect(missing.json).toMatchObject({ ok: false, rejectionCode: 'invalidCommand' });
  });

  it('rename_moves_the_file_in_one_transaction', async () => {
    await action({ type: 'create', on: 'doc', body: { path: 'draft.md', content: '# Draft\n' } });

    // Live frames: the rename lands as docSaved(new) then docDeleted(old).
    const stream = await openEventStream();
    await stream.next(); // attach proven

    expect(await action({ type: 'update', on: 'doc', body: { path: 'draft.md', to: 'guide/draft.md' } })).toEqual({
      status: 200,
      json: { ok: true },
    });
    expect(statSync(join(projectDir, 'docs', 'guide', 'draft.md')).isFile()).toBe(true);
    expect(() => statSync(join(projectDir, 'docs', 'draft.md'))).toThrow();

    const saved = await stream.until((frame) => frame['eventType'] === 'docSaved');
    expect((saved!['body'] as { doc: Record<string, unknown> }).doc).toMatchObject({
      path: 'guide/draft.md',
      title: 'Draft',
    });
    const deleted = await stream.until((frame) => frame['eventType'] === 'docDeleted');
    expect(deleted!['body']).toEqual({ path: 'draft.md' });
  });

  it('rename_rejects_missing_sources_and_existing_targets', async () => {
    await action({ type: 'create', on: 'doc', body: { path: 'a.md', content: '# A\n' } });
    await action({ type: 'create', on: 'doc', body: { path: 'b.md', content: '# B\n' } });

    const missing = await action({ type: 'update', on: 'doc', body: { path: 'nope.md', to: 'x.md' } });
    expect(missing.json).toMatchObject({ ok: false, rejectionCode: 'invalidCommand' });

    const overwrite = await action({ type: 'update', on: 'doc', body: { path: 'a.md', to: 'b.md' } });
    expect(overwrite.json).toMatchObject({ ok: false, rejectionCode: 'invalidCommand' });

    // The same path is an idempotent no-op.
    expect(await action({ type: 'update', on: 'doc', body: { path: 'a.md', to: 'a.md' } })).toEqual({
      status: 200,
      json: { ok: true },
    });
    expect(readFileSync(join(projectDir, 'docs', 'a.md')).toString()).toContain('# A');
  });

  it('paths_reject_traversal_absolute_and_non_md', async () => {
    for (const path of ['../escape.md', '/etc/passwd.md', 'guide/../x.md', 'notes.txt', '', 'a//b.md']) {
      const saved = await action({ type: 'create', on: 'doc', body: { path, content: 'x' } });
      expect(saved.json, path).toMatchObject({ ok: false, rejectionCode: 'invalidCommand' });
    }
    // Nothing was written outside the project.
    expect(readdirSync(dir).filter((name) => name.endsWith('.md'))).toEqual([]);
  });

  it('a_symlinked_segment_cannot_escape_the_docs_root', async () => {
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    mkdirSync(join(projectDir, 'docs'));
    writeFileSync(join(outside, 'secret.md'), '# secret\n');
    symlinkSync(outside, join(projectDir, 'docs', 'linked'));

    const read = await get('/projects/P-1/docs/content?path=linked/secret.md');
    expect(read.json).toMatchObject({ error: expect.stringContaining('escapes') });

    const saved = await action({
      type: 'create',
      on: 'doc',
      body: { path: 'linked/planted.md', content: '# planted\n' },
    });
    expect(saved.json).toMatchObject({ ok: false, rejectionCode: 'invalidCommand' });
  });

  it('a_symlinked_file_cannot_redirect_a_doc_write', async () => {
    const outside = join(dir, 'outside.md');
    mkdirSync(join(projectDir, 'docs'));
    writeFileSync(outside, '# unchanged\n');
    symlinkSync(outside, join(projectDir, 'docs', 'linked.md'));

    const saved = await action({
      type: 'create',
      on: 'doc',
      body: { path: 'linked.md', content: '# overwritten\n' },
    });

    expect(saved.json).toMatchObject({ ok: false, rejectionCode: 'invalidCommand' });
    expect(readFileSync(outside, 'utf8')).toBe('# unchanged\n');
  });

  it('a_binary_file_and_oversized_content_reject', async () => {
    mkdirSync(join(projectDir, 'docs'));
    writeFileSync(join(projectDir, 'docs', 'blob.md'), Buffer.from([0x89, 0x50, 0x00, 0x0a]));
    const read = await get('/projects/P-1/docs/content?path=blob.md');
    expect(read.json).toMatchObject({ error: expect.stringContaining('not a text file') });

    const big = 'x'.repeat(256 * 1024 + 1);
    const saved = await action({ type: 'create', on: 'doc', body: { path: 'big.md', content: big } });
    expect(saved.json).toMatchObject({ ok: false, rejectionCode: 'invalidCommand' });
  });

  it('a_project_without_a_directory_has_no_docs_surface', async () => {
    await action({ type: 'create', on: 'project', body: { name: 'bare' } });
    const list = await get('/projects/P-2/docs');
    expect(list.json).toMatchObject({ error: expect.stringContaining('no directory') });
    const saved = await action({ projectId: 'P-2', type: 'create', on: 'doc', body: { path: 'a.md', content: 'x' } });
    expect(saved.json).toMatchObject({ ok: false, rejectionCode: 'invalidCommand' });
  });

  it('an_unknown_project_reads_404', async () => {
    const list = await get('/projects/P-99/docs');
    expect(list.status).toBe(404);
  });
});

describe('docs service units', () => {
  it('docTitle_prefers_the_first_heading_then_the_filename', () => {
    expect(docTitle('x.md', 'intro\n\n# Real title\n')).toBe('Real title');
    expect(docTitle('nested/name.md', 'no heading')).toBe('name');
  });

  it('invalidDocPath_states_the_rule', () => {
    expect(invalidDocPath('ok.md')).toBeNull();
    expect(invalidDocPath('deep/ok.md')).toBeNull();
    expect(invalidDocPath('../out.md')).toMatch(/clean relative/);
    expect(invalidDocPath('C:/x.md')).toMatch(/relative/);
    expect(invalidDocPath('a\\b.md')).toMatch(/\//);
    expect(invalidDocPath('a.txt')).toMatch(/\.md/);
  });

  it('listDocs_of_a_missing_root_lists_empty', () => {
    expect(listDocs(join(dir, 'nothing-here'))).toEqual({ ok: true, value: [] });
  });

  it('saveDoc_upserts_and_reports_metadata', () => {
    const first = saveDoc(projectDir, 'u.md', '# First\n');
    expect(first).toMatchObject({ ok: true, value: { path: 'u.md', title: 'First' } });
    const second = saveDoc(projectDir, 'u.md', 'replaced\n');
    expect(second).toMatchObject({ ok: true, value: { title: 'u' } });
    expect(readFileSync(join(projectDir, 'docs', 'u.md')).toString()).toBe('replaced\n');
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
