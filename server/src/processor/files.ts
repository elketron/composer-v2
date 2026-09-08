// The file-backed domains' commands (Phase 9, S34): docs, knowledge, and
// the agent workflow recordings. The stores perform the writes inside the
// command path; the processor publishes metadata events around them. The
// open workflow recordings are the processor's only in-memory state
// between an agent's start and stop calls.

import { deleteDoc as deleteDocFile, renameDoc as renameDocFile, saveDoc as saveDocFile } from '../docs/index.js';
import { deleteWorkflow as deleteWorkflowFile, saveWorkflow, MAX_WORKFLOW_STEPS } from '../workflows.js';
import type { CommandOutcome } from '../wire/commands.js';
import { nowIso } from '../wire/envelope.js';
import type { WorkflowStep } from '../wire/models.js';
import { command, ok, rejected, type CommandMap } from './helpers.js';
import type { Processor } from './index.js';

  /** Creates or overwrites one doc; the event carries metadata only. */

export async function saveDoc(
    p: Processor,
    scope: string | undefined,
    path: string,
    content: string,
  ): Promise<CommandOutcome> {
    const directory = directoryOf(p, scope);
    if (typeof directory !== 'string') return directory;
    const result = saveDocFile(directory, path, content);
    if (!result.ok) return rejected('invalidCommand', result.error);
    await p.bus.publish(scope!, 'docSaved', { doc: result.value });
    return ok();
  }

  /** Deletes one doc; the tombstone is project-scoped, by path. */


  /** Deletes one doc; the tombstone is project-scoped, by path. */

export async function deleteDoc(p: Processor, scope: string | undefined, path: string): Promise<CommandOutcome> {
    const directory = directoryOf(p, scope);
    if (typeof directory !== 'string') return directory;
    const result = deleteDocFile(directory, path);
    if (!result.ok) return rejected('invalidCommand', result.error);
    await p.bus.publish(scope!, 'docDeleted', { path });
    return ok();
  }

  /**
   * Renames one doc (a single on-disk rename): the new metadata lands as
   * docSaved before the old path's docDeleted, so folds see an upsert
   * then the tombstone in either order. Same path is a no-op.
   */


  /**
   * Renames one doc (a single on-disk rename): the new metadata lands as
   * docSaved before the old path's docDeleted, so folds see an upsert
   * then the tombstone in either order. Same path is a no-op.
   */

export async function renameDoc(p: Processor, scope: string | undefined, path: string, to: string): Promise<CommandOutcome> {
    const directory = directoryOf(p, scope);
    if (typeof directory !== 'string') return directory;
    if (path === to) return ok();
    const result = renameDocFile(directory, path, to);
    if (!result.ok) return rejected('invalidCommand', result.error);
    await p.bus.publish(scope!, 'docSaved', { doc: result.value });
    await p.bus.publish(scope!, 'docDeleted', { path });
    return ok();
  }

  /** The linked directory of a file-backed command's scope, or the rejection. */


  /** The linked directory of a file-backed command's scope, or the rejection. */

export function directoryOf(p: Processor, scope: string | undefined): string | CommandOutcome {
    if (scope === undefined || !p.bus.state.projects.has(scope)) {
      return rejected('unknownProject', `Unknown project ${scope ?? ''}`);
    }
    const directory = p.bus.state.projects.get(scope)!.directory;
    if (directory === undefined) {
      return rejected('invalidCommand', `Project ${scope} has no directory set`);
    }
    return directory;
  }

  // ---- Knowledge (Phase 9): global writes over the data-dir library ----

  /**
   * Saves a note: with a path the content is the exact file (the
   * desktop's edit flow), without one title/tags frontmatter it and a
   * unique slug filename (the agent's save tool).
   */


  /**
   * Saves a note: with a path the content is the exact file (the
   * desktop's edit flow), without one title/tags frontmatter it and a
   * unique slug filename (the agent's save tool).
   */

export async function saveKnowledge(p: Processor, command: {
    path?: string;
    title?: string;
    tags?: string[];
    content: string;
  }): Promise<CommandOutcome> {
    if (p.knowledge === undefined) {
      return rejected('invalidCommand', 'knowledge storage is unavailable');
    }
    const result =
      command.path !== undefined && command.path.trim() !== ''
        ? p.knowledge.saveToFile(command.path, command.content)
        : p.knowledge.createEntry({
            title: command.title ?? '',
            tags: command.tags,
            content: command.content,
          });
    if (!result.ok) return rejected('invalidCommand', result.error);
    await p.bus.publish(undefined, 'knowledgeSaved', { entry: result.value });
    return { ok: true, savedPath: result.value.path };
  }

  /** Deletes one note; the tombstone is global, by path. */


  /** Deletes one note; the tombstone is global, by path. */

export async function deleteKnowledge(p: Processor, path: string): Promise<CommandOutcome> {
    if (p.knowledge === undefined) {
      return rejected('invalidCommand', 'knowledge storage is unavailable');
    }
    const result = p.knowledge.delete(path);
    if (!result.ok) return rejected('invalidCommand', result.error);
    await p.bus.publish(undefined, 'knowledgeDeleted', { path });
    return ok();
  }

  // ---- Agent workflows (S34): worker agents record procedures ----

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
    if (p.workflowRecordings.has(key)) {
      return rejected('invalidCommand', `Session ${sessionId} already has an open workflow recording`);
    }
    const trimmed = title.trim();
    if (trimmed === '') return rejected('invalidCommand', 'a workflow needs a title');
    p.workflowRecordings.set(key, {
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
    const recording = key !== null ? p.workflowRecordings.get(key) : undefined;
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
    const recording = key !== null ? p.workflowRecordings.get(key) : undefined;
    if (key === null || recording === undefined) {
      return rejected('invalidCommand', `Session ${sessionId} has no open workflow recording`);
    }
    if (recording.steps.length === 0) {
      return rejected('invalidCommand', 'a workflow needs at least one step — add steps or keep recording');
    }
    const result = saveWorkflow(directory, {
      title: recording.title,
      ...(recording.description !== '' ? { description: recording.description } : {}),
      tags: recording.tags,
      ...(recording.source !== undefined ? { source: recording.source } : {}),
      ...(recording.agent !== undefined ? { agent: recording.agent } : {}),
      steps: recording.steps,
      links,
      recordedAt: recording.startedAt,
    });
    if (!result.ok) return rejected('invalidCommand', result.error);
    p.workflowRecordings.delete(key);
    await p.bus.publish(projectId!, 'workflowSaved', { workflow: result.value });
    return { ok: true, savedPath: result.value.path };
  }

  /** Deletes one recorded workflow; the tombstone is project-scoped, by path. */


  /** Deletes one recorded workflow; the tombstone is project-scoped, by path. */

export async function deleteWorkflow(p: Processor, projectId: string | undefined, path: string): Promise<CommandOutcome> {
    const directory = directoryOf(p, projectId);
    if (typeof directory !== 'string') return directory;
    const result = deleteWorkflowFile(directory, path);
    if (!result.ok) return rejected('invalidCommand', result.error);
    await p.bus.publish(projectId!, 'workflowDeleted', { path });
    return ok();
  }


export const fileCommands: CommandMap = [
  command('requestDocSave', (p, scope, cmd) => saveDoc(p, scope, cmd.path, cmd.content)),
  command('requestDocRename', (p, scope, cmd) => renameDoc(p, scope, cmd.path, cmd.to)),
  command('requestDocDelete', (p, scope, cmd) => deleteDoc(p, scope, cmd.path)),
  command('requestKnowledgeSave', (p, _scope, cmd) => saveKnowledge(p, cmd)),
  command('requestKnowledgeDelete', (p, _scope, cmd) => deleteKnowledge(p, cmd.path)),
  command('requestWorkflowRecordStart', (p, scope, cmd) => startWorkflowRecording(p, scope, cmd.sessionId, cmd.title, cmd.description, cmd.tags)),
  command('requestWorkflowRecordStep', (p, scope, cmd) => addWorkflowRecordingStep(p, scope, cmd.sessionId, cmd.step)),
  command('requestWorkflowRecordStop', (p, scope, cmd) => stopWorkflowRecording(p, scope, cmd.sessionId, cmd.links)),
  command('requestWorkflowDelete', (p, scope, cmd) => deleteWorkflow(p, scope, cmd.path)),
];
