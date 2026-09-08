import type { GitRunner } from '../../dashboard/git.js';
import { readGitStatus } from '../../dashboard/git.js';
import type { State } from '../../fold/index.js';
import { projectDirectory } from './filesystem.js';
import type { ToolResult } from './types.js';

const MAX_DIFF_BYTES = 16 * 1024;
const MAX_LOG_COMMITS = 20;

export async function gitStatus(
  state: State,
  scope: string[],
  projectId: string,
  git: GitRunner | undefined,
): Promise<ToolResult> {
  const found = projectDirectory(state, scope, projectId);
  if ('ok' in found) return found;
  const status = await readGitStatus(found.base, git);
  return { ok: true, content: JSON.stringify(status, null, 2) };
}

export async function gitLog(
  state: State,
  scope: string[],
  projectId: string,
  limit: unknown,
  git: GitRunner | undefined,
): Promise<ToolResult> {
  const found = projectDirectory(state, scope, projectId);
  if ('ok' in found) return found;
  const count = Math.min(Math.max(Number(limit) || 10, 1), MAX_LOG_COMMITS);
  const output = await runGit(found.base, ['log', `--max-count=${count}`, '--format=%h%x00%s%x00%cI'], git);
  const commits = output
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [hash, subject, at] = line.split('\0');
      return { ...(hash ? { hash } : {}), ...(subject ? { subject } : {}), ...(at ? { at } : {}) };
    });
  return { ok: true, content: JSON.stringify({ commits }, null, 2) };
}

export async function gitDiff(
  state: State,
  scope: string[],
  projectId: string,
  path: string | undefined,
  git: GitRunner | undefined,
): Promise<ToolResult> {
  const found = projectDirectory(state, scope, projectId);
  if ('ok' in found) return found;
  const args = ['diff', '--no-color', ...(path !== undefined ? ['--', path] : [])];
  const output = await runGit(found.base, args, git);
  return {
    ok: true,
    content: JSON.stringify(
      {
        ...(path !== undefined ? { path } : {}),
        truncated: output.length > MAX_DIFF_BYTES,
        diff: output.slice(0, MAX_DIFF_BYTES),
      },
      null,
      2,
    ),
  };
}

function runGit(directory: string, args: string[], git: GitRunner | undefined): Promise<string> {
  const runner = git ?? defaultGit;
  return runner(directory, args).catch((error) => {
    throw new Error(`git failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

const defaultGit: GitRunner = async (directory, args) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const result = await promisify(execFile)('git', ['-C', directory, ...args], {
    encoding: 'utf8',
    timeout: 3_000,
    maxBuffer: 512 * 1024,
  });
  return result.stdout;
};
