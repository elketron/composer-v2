// Git status reading (transient repository state — nothing here is
// written to the event log): the bounded git runner, the porcelain parser,
// and the readGitStatus query the dashboard and the assistant's read tools
// share.

import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitStatus {
  status: 'clean' | 'dirty' | 'missing-directory' | 'not-repository' | 'error';
  branch?: string;
  latestCommit?: { hash: string; subject: string; at: string };
}

export type GitRunner = (directory: string, args: string[]) => Promise<string>;

const defaultGitRunner: GitRunner = async (directory, args) => {
  const result = await execFileAsync('git', ['-C', directory, ...args], {
    encoding: 'utf8',
    timeout: 3_000,
    maxBuffer: 128 * 1024,
  });
  return result.stdout;
};

/** Transient repository state. Nothing here is written to the event log. */
export async function readGitStatus(
  directory: string | undefined,
  run: GitRunner = defaultGitRunner,
): Promise<GitStatus> {
  if (!directory) return { status: 'missing-directory' };
  try {
    if (!(await stat(directory)).isDirectory()) return { status: 'missing-directory' };
  } catch {
    return { status: 'missing-directory' };
  }

  let statusOutput: string;
  try {
    statusOutput = await run(directory, ['status', '--porcelain=v1', '--branch']);
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    return { status: message.includes('not a git repository') ? 'not-repository' : 'error' };
  }

  const lines = statusOutput.replace(/\r/g, '').split('\n');
  const branch = parseBranch(lines[0] ?? '');
  const dirty = lines.slice(1).some((line) => line.trim() !== '');
  let latestCommit: GitStatus['latestCommit'];
  try {
    const output = await run(directory, ['log', '-1', '--format=%H%x00%s%x00%cI']);
    const [hash, subject, at] = output.trim().split('\0');
    if (hash && subject && at) latestCommit = { hash, subject, at };
  } catch {
    // A repository with no commits is still a valid repository.
  }

  return {
    status: dirty ? 'dirty' : 'clean',
    ...(branch ? { branch } : {}),
    ...(latestCommit ? { latestCommit } : {}),
  };
}

function parseBranch(header: string): string | undefined {
  if (!header.startsWith('## ')) return undefined;
  const value = header.slice(3).trim();
  if (value.startsWith('HEAD ')) return 'detached';
  if (value.startsWith('No commits yet on ')) return value.slice('No commits yet on '.length);
  return value.split('...')[0]?.trim() || undefined;
}

