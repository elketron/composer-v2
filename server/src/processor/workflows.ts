// The agent workflow domain's commands (S34): a worker agent records a
// procedure over its MCP tools — start opens the recording, add_step
// appends to it, stop finalizes it into `.composer/workflows/` (the write
// plus the metadata event, with `commitFile` compensation). The recordings
// live in the injected `WorkflowRecordings` registry, keyed by the agent
// session. Delete is the human/REST path.

import { MAX_WORKFLOW_STEPS } from '../workflows.js';
import type { CommandOutcome } from '../wire/commands.js';
import { nowIso } from '../wire/envelope.js';
import type { WorkflowStep } from '../wire/models.js';
import { command, ok, rejected, type CommandMap } from './helpers.js';
import { commitFile, directoryOf } from './files-util.js';
import type { Processor } from './index.js';

export function workflowRecordingKey(projectId: string | undefined, sessionId: string): string | null {
  if (projectId === undefined || projectId === '') return null;
  return `${projectId}/${sessionId}`;
}

export async function startWorkflowRecording(
  p: Processor,
  projectId: string | undefined,
  sessionId: string,
  title: string,
  description?: string,
  tags?: string[],
): Promise<CommandOutcome> {
  const directory = directoryOf(p, projectId);
  if (typeof directory !== 'string') return directory;
  const key = workflowRecordingKey(projectId, sessionId);
  if (key === null) return rejected('invalidCommand', 'a workflow recording needs a session');
  const session = p.bus.state.byProject.get(projectId!)?.agentSessions.get(sessionId);
  if (session === undefined) {
    return rejected('unknownSession', `Unknown agent session ${sessionId}`);
  }
  if (session.status !== 'running') {
    return rejected('invalidCommand', `Agent session ${sessionId} is not running`);
  }
  if (p.recordings.has(key)) {
    return rejected('invalidCommand', `Session ${sessionId} already has an open workflow recording`);
  }
  const trimmed = title.trim();
  if (trimmed === '') return rejected('invalidCommand', 'a workflow needs a title');
  p.recordings.set(key, {
    title: trimmed,
    description: description?.trim() ?? '',
    tags: (tags ?? []).map((tag) => tag.trim()).filter((tag) => tag !== ''),
    // The card and the worker the session belongs to (a pipeline agent
    // session's bound card and step kind).
    ...(session.cardId !== '' ? { source: session.cardId } : {}),
    ...(session.agentKind !== undefined ? { agent: session.agentKind } : {}),
    steps: [],
    startedAt: nowIso(),
  });
  return ok();
}

export async function addWorkflowRecordingStep(
  p: Processor,
  projectId: string | undefined,
  sessionId: string,
  step: WorkflowStep,
): Promise<CommandOutcome> {
  const key = workflowRecordingKey(projectId, sessionId);
  const recording = key !== null ? p.recordings.get(key) : undefined;
  if (key === null || recording === undefined) {
    return rejected('invalidCommand', `Session ${sessionId} has no open workflow recording`);
  }
  const title = step.title.trim();
  if (title === '') return rejected('invalidCommand', 'a workflow step needs a title');
  if (recording.steps.length >= MAX_WORKFLOW_STEPS) {
    return rejected('invalidCommand', `a workflow may not exceed ${MAX_WORKFLOW_STEPS} steps`);
  }
  recording.steps.push({
    title,
    ...(step.detail?.trim() ? { detail: step.detail.trim() } : {}),
    ...(step.command?.trim() ? { command: step.command.trim() } : {}),
  });
  return ok();
}

export async function stopWorkflowRecording(
  p: Processor,
  projectId: string | undefined,
  sessionId: string,
  links?: string[],
): Promise<CommandOutcome> {
  const directory = directoryOf(p, projectId);
  if (typeof directory !== 'string') return directory;
  const key = workflowRecordingKey(projectId, sessionId);
  const recording = key !== null ? p.recordings.get(key) : undefined;
  if (key === null || recording === undefined) {
    return rejected('invalidCommand', `Session ${sessionId} has no open workflow recording`);
  }
  if (recording.steps.length === 0) {
    return rejected('invalidCommand', 'a workflow needs at least one step — add steps or keep recording');
  }
  return commitFile(
    () =>
      p.files.workflows.save(directory, {
        title: recording.title,
        ...(recording.description !== '' ? { description: recording.description } : {}),
        tags: recording.tags,
        ...(recording.source !== undefined ? { source: recording.source } : {}),
        ...(recording.agent !== undefined ? { agent: recording.agent } : {}),
        steps: recording.steps,
        links,
        recordedAt: recording.startedAt,
      }),
    async (workflow) => p.bus.publish(projectId!, 'workflowSaved', { workflow }),
    (workflow) => {
      p.recordings.delete(key);
      return { ok: true, savedPath: workflow.path };
    },
  );
}

/** Deletes one recorded workflow; the tombstone is project-scoped, by path. */
export async function deleteWorkflow(p: Processor, projectId: string | undefined, path: string): Promise<CommandOutcome> {
  const directory = directoryOf(p, projectId);
  if (typeof directory !== 'string') return directory;
  return commitFile(
    () => p.files.workflows.remove(directory, path),
    async () => p.bus.publish(projectId!, 'workflowDeleted', { path }),
  );
}

export const workflowCommands: CommandMap = [
  command('requestWorkflowRecordStart', (p, scope, cmd) => startWorkflowRecording(p, scope, cmd.sessionId, cmd.title, cmd.description, cmd.tags)),
  command('requestWorkflowRecordStep', (p, scope, cmd) => addWorkflowRecordingStep(p, scope, cmd.sessionId, cmd.step)),
  command('requestWorkflowRecordStop', (p, scope, cmd) => stopWorkflowRecording(p, scope, cmd.sessionId, cmd.links)),
  command('requestWorkflowDelete', (p, scope, cmd) => deleteWorkflow(p, scope, cmd.path)),
];