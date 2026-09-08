// The project commands: creation (with directory linking), directory
// updates, activation, archive, and restore. Archive refuses while a run
// is active; archive/restore are idempotent. Directory resolution is the
// injected canonical resolver (filesystem/directory.ts); the duplicate-link
// policy stays here.

import { nowIso } from '../wire/envelope.js';
import type { CommandOutcome } from '../wire/commands.js';
import type { Project } from '../wire/models.js';
import { defaultPipeline } from '../pipelines.js';
import { command, allocateId, ok, rejected, type CommandMap } from './helpers.js';
import type { Processor } from './index.js';

export async function createProject(p: Processor, name: string, directory?: string): Promise<CommandOutcome> {
    const trimmed = name.trim();
    if (trimmed === '') {
      return rejected('invalidCommand', 'Project name is required');
    }
    if (
      [...p.bus.state.projects.values()].some(
        (project) => project.name.toLowerCase() === trimmed.toLowerCase(),
      )
    ) {
      return rejected('invalidCommand', `Project '${trimmed}' already exists`);
    }
    const resolved = p.resolveDirectory(directory);
    if (directory !== undefined && directory.trim() !== '' && resolved === null) {
      return rejected('invalidCommand', 'Project directory must exist');
    }
    if (
      resolved !== null &&
      [...p.bus.state.projects.values()].some((project) =>
        sameDirectory(project.directory, resolved),
      )
    ) {
      return rejected('invalidCommand', `Directory '${resolved}' is already linked`);
    }

    const project: Project = {
      id: allocateId([...p.bus.state.projects.keys()], 'P'),
      name: trimmed,
      ...(resolved !== null ? { directory: resolved } : {}),
      createdAt: new Date().toISOString(),
    };
    await p.bus.publish(project.id, 'projectCreated', { project });
    await p.bus.publish(project.id, 'projectActivated', { projectId: project.id });
    // The default coding pipeline rides the project's creation (deterministic
    // log order; the boot seed only covers logs that predate it).
    await p.bus.publish(project.id, 'pipelineSaved', { pipeline: defaultPipeline(project.id) });
    return ok();
  }


export async function setProjectDirectory(
    p: Processor,
    scope: string | undefined,
    commandProjectId: string,
    directory: string,
  ): Promise<CommandOutcome> {
    if (scope !== commandProjectId) {
      return rejected('unknownProject', `Unknown project ${scope ?? ''}`);
    }
    const project = p.bus.state.projects.get(commandProjectId);
    if (!project) {
      return rejected('unknownProject', `Unknown project ${commandProjectId}`);
    }
    const resolved = p.resolveDirectory(directory);
    if (resolved === null) {
      return rejected('invalidCommand', 'Project directory must exist');
    }
    if (
      [...p.bus.state.projects.values()].some(
        (other) => other.id !== commandProjectId && sameDirectory(other.directory, resolved),
      )
    ) {
      return rejected('invalidCommand', `Directory '${resolved}' is already linked`);
    }
    if (sameDirectory(project.directory, resolved)) {
      return ok();
    }
    await p.bus.publish(commandProjectId, 'projectDirectoryChanged', {
      projectId: commandProjectId,
      directory: resolved,
    });
    return ok();
  }


export async function activateProject(p: Processor, projectId: string): Promise<CommandOutcome> {
    if (!p.bus.state.projects.has(projectId)) {
      return rejected('unknownProject', `Unknown project ${projectId}`);
    }
    await p.bus.publish(projectId, 'projectActivated', { projectId });
    return ok();
  }


export async function archiveProject(
    p: Processor,
    scope: string | undefined,
    commandProjectId: string,
  ): Promise<CommandOutcome> {
    if (scope !== commandProjectId) {
      return rejected('unknownProject', `Unknown project ${scope ?? ''}`);
    }
    const project = p.bus.state.projects.get(commandProjectId);
    if (!project) {
      return rejected('unknownProject', `Unknown project ${commandProjectId}`);
    }
    if (project.isArchived) return ok();
    const activeRuns = [...(p.bus.state.byProject.get(commandProjectId)?.runs.values() ?? [])].some(
      (run) => run.isActive,
    );
    if (activeRuns) {
      return rejected('invalidCommand', `Project ${commandProjectId} has an active pipeline run`);
    }
    await p.bus.publish(commandProjectId, 'projectArchived', {
      projectId: commandProjectId,
      archivedAt: nowIso(),
    });
    return ok();
  }


export async function restoreProject(
    p: Processor,
    scope: string | undefined,
    commandProjectId: string,
  ): Promise<CommandOutcome> {
    if (scope !== commandProjectId) {
      return rejected('unknownProject', `Unknown project ${scope ?? ''}`);
    }
    const project = p.bus.state.projects.get(commandProjectId);
    if (!project) {
      return rejected('unknownProject', `Unknown project ${commandProjectId}`);
    }
    if (!project.isArchived) return ok();
    await p.bus.publish(commandProjectId, 'projectRestored', {
      projectId: commandProjectId,
      restoredAt: nowIso(),
    });
    return ok();
  }

  // ---- Cards ----

  /**
   * Creates one or more cards (v1 `create_cards`): the scope must exist and
   * every `blockedBy` must reference a card that exists at command time
   * (in-batch cross-references are planner-ticket territory, not this).
   * Every card is assigned to a pipeline — the requested one, else the
   * project's default — and begins in that pipeline's first stage.
   * Events publish per card, so each allocation sees the previous one.
   */


/** Two canonical directory strings that name the same path. */
function sameDirectory(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  return trimEndingSeparator(left) === trimEndingSeparator(right);
}

function trimEndingSeparator(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  return trimmed === '' ? path : trimmed;
}

export const projectCommands: CommandMap = [
  command('requestProjectCreate', (p, _scope, cmd) => createProject(p, cmd.name, cmd.directory)),
  command('requestProjectSetDirectory', (p, scope, cmd) => setProjectDirectory(p, scope, cmd.projectId, cmd.directory)),
  command('requestProjectActivate', (p, _scope, cmd) => activateProject(p, cmd.projectId)),
  command('requestProjectArchive', (p, scope, cmd) => archiveProject(p, scope, cmd.projectId)),
  command('requestProjectRestore', (p, scope, cmd) => restoreProject(p, scope, cmd.projectId)),
];
