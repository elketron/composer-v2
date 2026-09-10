// The justfile route and its parser: one project's recipes (the editor's
// "just recipe" presets), read straight from the project directory's
// justfile — recipes at column 0, assignments/aliases excluded, required
// parameters excluded, comment blocks feeding the descriptions.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boot } from '../src/index.js';
import { parseJustfile } from '../src/filesystem/justfile.js';

let dir: string;
let server: Awaited<ReturnType<typeof boot>>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'composer-just-'));
  server = await boot({ addr: '127.0.0.1:0', dataDir: join(dir, 'data') });
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

describe('parseJustfile', () => {
  it('reads_recipes_with_comments_and_skips_assignments_aliases_and_required_params', () => {
    const justfile = [
      '# set the rust flags',
      'export RUSTFLAGS := "-C target-cpu=native"',
      '',
      '# Build the project',
      'build:',
      '    pnpm build',
      '',
      'check target: build',
      '    just build',
      '',
      'alias c := check',
      '',
      '[private]',
      'deploy:  # ship it',
      '    ./deploy.sh',
      '',
      'worktree dir="smoke":',
      '    echo worktree',
      '',
      '@quiet-recipe:',
      '    echo quiet',
    ].join('\n');

    expect(parseJustfile(justfile)).toEqual([
      { name: 'build', description: 'Build the project' },
      { name: 'deploy', description: 'ship it' },
      { name: 'worktree', description: '' },
      { name: 'quiet-recipe', description: '' },
    ]);
  });

  it('answers_null_when_nothing_parses', () => {
    expect(parseJustfile('x := "y"\nalias b := x\n')).toBeNull();
  });
});

describe('GET /justfile', () => {
  it('serves_the_project_s_recipes', async () => {
    const projectDir = join(dir, 'proj');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, 'justfile'),
      '# build things\nbuild:\n    pnpm build\ncheck: build\n    just build\n',
    );
    await action({ type: 'create', on: 'project', body: { name: 'just', directory: projectDir } });

    const response = await fetch(`${server.url}/justfile?projectId=P-1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      recipes: [
        { name: 'build', description: 'build things' },
        { name: 'check', description: '' },
      ],
    });
  });

  it('answers_an_empty_list_without_a_justfile_and_404_for_unknown_projects', async () => {
    await action({ type: 'create', on: 'project', body: { name: 'bare' } });
    const bare = await fetch(`${server.url}/justfile?projectId=P-1`);
    expect(await bare.json()).toEqual({ recipes: [] });

    const unknown = await fetch(`${server.url}/justfile?projectId=P-99`);
    expect(unknown.status).toBe(404);
  });
});
