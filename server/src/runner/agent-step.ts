// The agent step body: ships the worker agent into the project, opens the
// card-bound agent session, streams the engine's turn as events, and
// collects the reported outcome (S36) for the drive loop to apply.

import { allocateId } from '../processor.js';
import { nowIso } from '../wire/envelope.js';
import { ensureAgentFiles } from '../agents/index.js';
import { resolveModel } from '../store/settings.js';
import type { Bus } from '../bus.js';
import type { AgentEngine, AgentTurnEvent, AgentTurnSpec } from '../engine/types.js';
import type { PipelineStep } from '../wire/models.js';
import { promptFor } from './prompts.js';
import type { RunTask, RunnerOptions } from './types.js';

export type AgentStepResult =
  | { ok: true; outcome?: { stepId: string; outcome: string; note?: string } }
  | { ok: false; error: string };

export async function runAgentStep(
  bus: Bus,
  engine: AgentEngine,
  options: RunnerOptions & Required<Pick<RunnerOptions, 'agentTimeoutMs'>>,
  task: RunTask,
  step: PipelineStep,
  outcomeBrief: string | undefined,
): Promise<AgentStepResult> {
  const directory = bus.state.projects.get(task.projectId)?.directory;
  const card = bus.state.byProject.get(task.projectId)?.cards.get(task.cardId);
  if (directory === undefined) {
    return { ok: false, error: `Project ${task.projectId} has no directory set` };
  }
  if (card === undefined) {
    return { ok: false, error: `Card ${task.cardId} vanished` };
  }
  // The shipped agent the step names; ship it if absent.
  try {
    ensureAgentFiles(directory);
  } catch (error) {
    return { ok: false, error: `could not ship agent files: ${String(error)}` };
  }
  // The outcome report belongs to this step only: anything a previous
  // step's agent reported is stale by definition.
  task.outcome = null;

  const sessionId = allocateId(bus.state.byProject.get(task.projectId)?.agentSessions.keys() ?? [], 'A');
  await bus.publish(task.projectId, 'agentSessionStarted', {
    cardId: task.cardId,
    sessionId,
    agentKind: step.agentKind ?? 'coder',
    startedAt: nowIso(),
  });

  const settings = (await options.getModel?.()) ?? {};
  const agentKind = step.agentKind ?? 'coder';
  const model = resolveModel(settings, agentKind);
  const spec: AgentTurnSpec = {
    projectId: task.projectId,
    sessionId,
    projectDirectory: directory,
    prompt: promptFor(agentKind, card, step, outcomeBrief),
    serverUrl: options.serverUrl ?? '',
    mcpScriptPath: options.mcpScriptPath ?? '',
    agentName: `composer-${agentKind}`,
    ...(model ? { model } : {}),
    timeoutMs: options.agentTimeoutMs,
    signal: task.abort.signal,
    // The workers' own surface: workflow recording + retrieval. The
    // planner's write tools stay the planner's.
    mcpTools: 'worker',
  };
  const onEvent = (event: AgentTurnEvent): void => {
    if (event.kind === 'toolCall') {
      void bus
        .publish(task.projectId, 'agentToolCall', {
          sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ...(event.args !== undefined ? { args: event.args as Record<string, unknown> } : {}),
        })
        .catch((error) => console.error('runner: failed to publish a tool call:', error));
      return;
    }
    if (event.kind === 'toolResult') {
      void bus
        .publish(task.projectId, 'agentToolResult', {
          sessionId,
          toolCallId: event.toolCallId,
          content: event.content,
          isError: event.isError,
        })
        .catch((error) => console.error('runner: failed to publish a tool result:', error));
      return;
    }
    const body =
      event.kind === 'messageDelta'
        ? { sessionId, messageIndex: nextAgentMessageIndex(bus, sessionId), delta: event.delta }
        : {
            sessionId,
            message: {
              index: nextAgentMessageIndex(bus, sessionId),
              role: 'agent',
              text: event.text,
              at: nowIso(),
            },
          };
    void bus
      .publish(task.projectId, event.kind === 'messageDelta' ? 'agentMessageDelta' : 'agentMessageComplete', body)
      .catch((error) => console.error('runner: failed to publish an agent event:', error));
  };
  const outcome = await engine.run(spec, onEvent);

  await bus.publish(task.projectId, 'agentSessionEnded', {
    cardId: task.cardId,
    sessionId,
    status: outcome.ok ? 'ended' : 'failed',
    ...(outcome.ok ? {} : { error: outcome.error }),
    endedAt: nowIso(),
  });
  if (!outcome.ok) {
    task.outcome = null;
    return { ok: false, error: outcome.error ?? 'the agent step failed' };
  }
  // A report recorded for this step rides the result; the drive applies
  // the stage's outcome rules to it.
  const reported = reportedOutcome(task, step.id);
  task.outcome = null;
  return { ok: true, ...(reported !== undefined ? { outcome: reported } : {}) };
}

/** The run task's outcome report for one step, if one landed (a function read: property narrowing resets). */
function reportedOutcome(task: RunTask, stepId: string): { stepId: string; outcome: string; note?: string } | undefined {
  return task.outcome?.stepId === stepId ? (task.outcome ?? undefined) : undefined;
}

function nextAgentMessageIndex(bus: Bus, sessionId: string): number {
  const session = [...bus.state.byProject.values()]
    .flatMap((project) => [...project.agentSessions.values()])
    .find((session) => session.id === sessionId);
  const messages = session?.transcript.filter((entry) => entry.kind === 'message') ?? [];
  return messages.reduce((max, entry) => (entry.kind === 'message' ? Math.max(max, entry.message.index) : max), 0) + 1;
}
