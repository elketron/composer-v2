import { emptyProjectState, type State } from '../fold/index.js';
import { Board } from '../domain/board.js';
import type { Run } from '../domain/run.js';
import { readGitStatus, type GitStatus } from './git.js';

export { readGitStatus, type GitRunner, type GitStatus } from './git.js';

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

export async function dashboardProjects(
  state: State,
  readGit: (directory: string | undefined) => Promise<GitStatus> = readGitStatus,
): Promise<DashboardProject[]> {
  const projects = [...state.projects.values()]
    .filter((project) => project.archivedAt === undefined)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return mapLimit(projects, 4, async (project) => {
    const board = Board.of(state.byProject.get(project.id) ?? emptyProjectState(project.id));
    const cardTitle = (cardId: string): string => board.card(cardId)?.title ?? cardId;
    const waitingApprovals = [...board.runs.values()]
      .filter((run) => run.status === 'waiting')
      .map((run) => ({
        runId: run.id,
        cardId: run.cardId,
        cardTitle: cardTitle(run.cardId),
        pipelineId: run.pipelineId,
      }))
      .sort((a, b) => a.cardId.localeCompare(b.cardId));
    // The card's latest run feeds health: only execution failures are
    // actionable (a `returned` run is a successful outcome route, e.g.
    // changes_requested, not a failure).
    const failedRuns = [...new Set([...board.runs.values()].map((run) => run.cardId))]
      .map((cardId) => board.latestRunOf(cardId))
      .filter((run): run is Run => run !== undefined && run.status === 'failed')
      .map((run) => ({
        runId: run.id,
        cardId: run.cardId,
        cardTitle: cardTitle(run.cardId),
        pipelineId: run.pipelineId,
        ...(run.error !== undefined ? { error: run.error } : {}),
        ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
      }))
      .sort((a, b) => a.cardId.localeCompare(b.cardId));

    return {
      id: project.id,
      name: project.name,
      ...(project.directory !== undefined ? { directory: project.directory } : {}),
      runningRuns: [...board.runs.values()].filter((run) => run.status === 'running').length,
      waitingApprovals,
      failedRuns,
      git: await readGit(project.directory),
    };
  });
}

/** Maps values with a bounded concurrency (the per-project git reads). */
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
