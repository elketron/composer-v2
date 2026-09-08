import { Board } from '../../domain/board.js';
import type { Run } from '../../domain/run.js';
import { emptyProjectState, type State } from '../../fold/index.js';
import type { KnowledgeStore } from '../../knowledge.js';
import { scoped } from './guards.js';
import type { ToolResult } from './types.js';

export function composerOverview(state: State, scope: string[], projectId: string | undefined): ToolResult {
  const ids = projectId !== undefined ? [projectId] : scope;
  if (ids.length === 0) return { ok: false, error: 'the thread has no projects in scope' };
  const unknown = ids.find((id) => !scope.includes(id));
  if (unknown !== undefined) return { ok: false, error: `project ${unknown} is not in this thread's scope` };
  const projects = ids
    .map((id) => state.projects.get(id))
    .filter((project): project is NonNullable<typeof project> => project !== undefined);
  if (projects.length === 0) return { ok: false, error: `unknown project ${ids[0]}` };

  const body = projects.map((project) => {
    const board = Board.of(state.byProject.get(project.id) ?? emptyProjectState(project.id));
    const cards = [...board.cards.values()];
    const byStage: Record<string, number> = {};
    for (const card of cards) {
      const label = board.pipelineOf(card)?.stageById(card.stageId)?.label ?? card.stageId;
      byStage[label] = (byStage[label] ?? 0) + 1;
    }
    const latestRuns = [...new Set([...board.runs.values()].map((run) => run.cardId))]
      .map((cardId) => board.latestRunOf(cardId))
      .filter((run): run is Run => run !== undefined)
      .map((run) => ({
        runId: run.id,
        cardId: run.cardId,
        cardTitle: board.card(run.cardId)?.title ?? run.cardId,
        pipelineId: run.pipelineId,
        status: run.status,
        ...(run.error !== undefined ? { error: run.error } : {}),
      }));
    const activeRuns = [...board.runs.values()]
      .filter((run) => run.isActive)
      .map((run) => ({
        runId: run.id,
        cardId: run.cardId,
        pipelineId: run.pipelineId,
        status: run.status,
        stepKind: run.stepKind,
      }));
    const planningSessions = state.byProject.get(project.id)?.planningSessions ?? new Map();
    const sessions = [...planningSessions.values()].map((session) => ({
      id: session.id,
      status: session.status,
      messages: session.messages.length,
      documentChars: session.planDocument.length,
    }));
    return {
      project: { id: project.id, name: project.name, ...(project.directory ? { directory: project.directory } : {}) },
      cards: { total: cards.length, byStage },
      activeRuns,
      latestRuns,
      planningSessions: sessions,
    };
  });
  return { ok: true, content: JSON.stringify(projectId !== undefined ? body[0] : body, null, 2) };
}

export function composerCard(state: State, scope: string[], projectId: string, cardId: string): ToolResult {
  const scopeError = scoped(scope, projectId);
  if (scopeError) return scopeError;
  const board = Board.of(state.byProject.get(projectId) ?? emptyProjectState(projectId));
  const card = board.card(cardId);
  if (!card) return { ok: false, error: `unknown card ${cardId}` };
  const latestRun = board.latestRunOf(cardId);
  const transcriptSessions = [...(state.byProject.get(projectId)?.agentSessions.values() ?? [])]
    .filter((session) => session.cardId === cardId)
    .map((session) => ({
      id: session.id,
      status: session.status,
      entries: session.transcript.length,
      ...(session.error !== undefined ? { error: session.error } : {}),
    }));
  return {
    ok: true,
    content: JSON.stringify(
      { ...card, ...(latestRun !== undefined ? { latestRun } : {}), agentSessions: transcriptSessions },
      null,
      2,
    ),
  };
}

export function composerPlan(
  state: State,
  scope: string[],
  projectId: string,
  sessionId: string | undefined,
): ToolResult {
  const scopeError = scoped(scope, projectId);
  if (scopeError) return scopeError;
  const sessions = [...(state.byProject.get(projectId)?.planningSessions.values() ?? [])].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const session = sessionId !== undefined ? sessions.find((entry) => entry.id === sessionId) : sessions.at(-1);
  if (!session) {
    return {
      ok: false,
      error: sessionId !== undefined ? `unknown session ${sessionId}` : `project ${projectId} has no planning sessions`,
    };
  }
  return {
    ok: true,
    content: JSON.stringify({ id: session.id, status: session.status, planDocument: session.planDocument }, null, 2),
  };
}

export function knowledgeSearch(knowledge: KnowledgeStore | undefined, query: string): ToolResult {
  if (knowledge === undefined) return { ok: false, error: 'knowledge storage is unavailable' };
  const results = knowledge.search(query);
  return {
    ok: true,
    content: JSON.stringify(
      {
        query,
        results: results.map((result) => ({
          path: result.info.path,
          title: result.info.title,
          tags: result.info.tags,
          score: result.score,
          snippet: result.snippet,
        })),
      },
      null,
      2,
    ),
  };
}
