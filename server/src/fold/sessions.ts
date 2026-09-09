// The agent-session domain's fold steps (the workers' card-bound
// sessions): start, end, and the transcript's tool activity. The
// messages ride the planning fold's shared message upsert.

import { projectStateOf, readBody, type FoldHandler } from './state.js';

export const sessionHandlers: Record<string, FoldHandler> = {
  agentSessionStarted: (state, envelope, projectId) => {
    const body = readBody(envelope, 'agentSessionStarted');
    projectStateOf(state, projectId).agentSessions.set(body.sessionId, {
      id: body.sessionId,
      projectId,
      cardId: body.cardId,
      agentKind: body.agentKind,
      status: 'running',
      startedAt: body.startedAt,
      transcript: [],
      ...(body.runId !== undefined ? { runId: body.runId } : {}),
      ...(body.stepId !== undefined ? { stepId: body.stepId } : {}),
    });
  },
  agentSessionEnded: (state, envelope, projectId) => {
    const body = readBody(envelope, 'agentSessionEnded');
    const session = projectStateOf(state, projectId).agentSessions.get(body.sessionId);
    if (!session) return;
    session.status = body.status;
    session.endedAt = body.endedAt;
    if (body.error !== undefined) session.error = body.error;
  },
  agentSessionObserved: (state, envelope, projectId) => {
    const body = readBody(envelope, 'agentSessionObserved');
    const session = projectStateOf(state, projectId).agentSessions.get(body.sessionId);
    if (!session) return;
    if (body.usage !== undefined) session.usage = structuredClone(body.usage);
    if (body.files !== undefined) session.files = structuredClone(body.files);
  },
  agentToolCall: (state, envelope, projectId) => {
    const body = readBody(envelope, 'agentToolCall');
    const project = projectStateOf(state, projectId);
    const session = project.agentSessions.get(body.sessionId);
    if (session) {
      session.transcript.push({
        kind: 'toolCall',
        toolCallId: body.toolCallId,
        toolName: body.toolName,
        args: body.args,
      });
      return;
    }
    const planning = project.planningSessions.get(body.sessionId);
    if (!planning) return;
    planning.toolCalls ??= [];
    if (!planning.toolCalls.some((entry) => entry.toolCallId === body.toolCallId)) {
      planning.toolCalls.push({
        toolCallId: body.toolCallId,
        ...(body.parentIndex !== undefined ? { parentIndex: body.parentIndex } : {}),
        toolName: body.toolName,
        args: structuredClone(body.args),
      });
    }
  },
  agentToolResult: (state, envelope, projectId) => {
    const body = readBody(envelope, 'agentToolResult');
    const project = projectStateOf(state, projectId);
    const session = project.agentSessions.get(body.sessionId);
    if (session) {
      session.transcript.push({
        kind: 'toolResult',
        toolCallId: body.toolCallId,
        content: body.content,
        isError: body.isError,
      });
      return;
    }
    const entry = project.planningSessions
      .get(body.sessionId)
      ?.toolCalls?.find((tool) => tool.toolCallId === body.toolCallId);
    if (entry) {
      entry.summary = body.content;
      entry.isError = body.isError;
    }
  },
};
