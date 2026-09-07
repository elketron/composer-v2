import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';

import type { RunRecord, State } from './fold.js';

const execFileAsync = promisify(execFile);

export interface GitStatus {
  status: 'clean' | 'dirty' | 'missing-directory' | 'not-repository' | 'error';
  branch?: string;
  latestCommit?: { hash: string; subject: string; at: string };
}

export interface DashboardProject {
  id: string;
  name: string;
  directory?: string;
  runningRuns: number;
  waitingApprovals: Array<{ runId: string; cardId: string; cardTitle: string; pipelineId: string }>;
  failedRuns: Array<{
    runId: string;
    cardId: string;
    cardTitle: string;
    pipelineId: string;
    error?: string;
    endedAt?: string;
  }>;
  git: GitStatus;
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

export async function dashboardProjects(
  state: State,
  readGit: (directory: string | undefined) => Promise<GitStatus> = readGitStatus,
): Promise<DashboardProject[]> {
  const projects = [...state.projects.values()]
    .filter((project) => project.archivedAt === undefined)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return mapLimit(projects, 4, async (project) => {
    const projectState = state.byProject.get(project.id);
    const waitingApprovals = [...(projectState?.runs.values() ?? [])]
      .filter((run) => run.status === 'waiting')
      .map((run) => ({
        runId: run.id,
        cardId: run.cardId,
        cardTitle: projectState?.cards.get(run.cardId)?.title ?? run.cardId,
        pipelineId: run.pipelineId,
      }))
      .sort((a, b) => a.cardId.localeCompare(b.cardId));
    // The card's latest run feeds health: failed and returned runs are both
    // actionable (a returned run means work came back from a later stage).
    const latestRunByCard = new Map<string, RunRecord>();
    for (const run of projectState?.runs.values() ?? []) {
      const latest = latestRunByCard.get(run.cardId);
      if (latest === undefined || run.startedAt >= latest.startedAt) latestRunByCard.set(run.cardId, run);
    }
    const failedRuns = [...latestRunByCard.values()]
      .filter((run) => run.status === 'failed' || run.status === 'returned')
      .map((run) => ({
        runId: run.id,
        cardId: run.cardId,
        cardTitle: projectState?.cards.get(run.cardId)?.title ?? run.cardId,
        pipelineId: run.pipelineId,
        ...(run.error !== undefined ? { error: run.error } : {}),
        ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
      }))
      .sort((a, b) => a.cardId.localeCompare(b.cardId));

    return {
      id: project.id,
      name: project.name,
      ...(project.directory !== undefined ? { directory: project.directory } : {}),
      runningRuns: [...(projectState?.runs.values() ?? [])].filter((run) => run.status === 'running').length,
      waitingApprovals,
      failedRuns,
      git: await readGit(project.directory),
    };
  });
}

function parseBranch(header: string): string | undefined {
  if (!header.startsWith('## ')) return undefined;
  const value = header.slice(3).trim();
  if (value.startsWith('HEAD ')) return 'detached';
  if (value.startsWith('No commits yet on ')) return value.slice('No commits yet on '.length);
  return value.split('...')[0]?.trim() || undefined;
}

async function mapLimit<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next++;
      results[index] = await map(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}
