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
  agentToolCall: (state, envelope, projectId) => {
    const body = readBody(envelope, 'agentToolCall');
    const session = projectStateOf(state, projectId).agentSessions.get(body.sessionId);
    if (!session) return;
    session.transcript.push({
      kind: 'toolCall',
      toolCallId: body.toolCallId,
      toolName: body.toolName,
      args: body.args,
    });
  },
  agentToolResult: (state, envelope, projectId) => {
    const body = readBody(envelope, 'agentToolResult');
    const session = projectStateOf(state, projectId).agentSessions.get(body.sessionId);
    if (!session) return;
    session.transcript.push({
      kind: 'toolResult',
      toolCallId: body.toolCallId,
      content: body.content,
      isError: body.isError,
    });
  },
};
