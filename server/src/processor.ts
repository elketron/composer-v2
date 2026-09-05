// Command validation → canonical events (v1 architecture.md §Server
// command validation). Same validation order, same rejection messages, and
// the same emitted event lists as v1 for the domains v2 keeps. Human drags
// are never blocked by automation toggles.

import { statSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import type { Bus } from './bus.js';
import type { Command, CommandOutcome, Rejection } from './wire/commands.js';
import type { Project } from './wire/models.js';

export class Processor {
  private bus: Bus;

  constructor(bus: Bus) {
    this.bus = bus;
  }

  /**
   * Validates a command in the given project scope and, on success,
   * publishes the canonical events (persisted, folded, fanned out) before
   * resolving. S0 handles the project domain; the rest join per slice.
   */
  async execute(projectId: string | undefined, command: Command): Promise<CommandOutcome> {
    switch (command.type) {
      case 'requestProjectCreate':
        return this.createProject(command.name, command.directory);
      case 'requestProjectSetDirectory':
        return this.setProjectDirectory(projectId, command.projectId, command.directory);
      case 'requestProjectActivate':
        return this.activateProject(command.projectId);
      default:
        return rejected('invalidCommand', `${command.type} is not implemented yet`);
    }
  }

  private async createProject(name: string, directory?: string): Promise<CommandOutcome> {
    const trimmed = name.trim();
    if (trimmed === '') {
      return rejected('invalidCommand', 'Project name is required');
    }
    if (
      [...this.bus.state.projects.values()].some(
        (project) => project.name.toLowerCase() === trimmed.toLowerCase(),
      )
    ) {
      return rejected('invalidCommand', `Project '${trimmed}' already exists`);
    }
    const resolved = resolveDirectory(directory);
    if (directory !== undefined && directory.trim() !== '' && resolved === null) {
      return rejected('invalidCommand', 'Project directory must exist');
    }
    if (
      resolved !== null &&
      [...this.bus.state.projects.values()].some((project) =>
        sameDirectory(project.directory, resolved),
      )
    ) {
      return rejected('invalidCommand', `Directory '${resolved}' is already linked`);
    }

    const project: Project = {
      id: allocateId([...this.bus.state.projects.keys()], 'P'),
      name: trimmed,
      ...(resolved !== null ? { directory: resolved } : {}),
      createdAt: new Date().toISOString(),
    };
    await this.bus.publish(project.id, 'projectCreated', { project });
    await this.bus.publish(project.id, 'projectActivated', { projectId: project.id });
    return ok();
  }

  private async setProjectDirectory(
    scope: string | undefined,
    commandProjectId: string,
    directory: string,
  ): Promise<CommandOutcome> {
    if (scope !== commandProjectId) {
      return rejected('unknownProject', `Unknown project ${scope ?? ''}`);
    }
    const project = this.bus.state.projects.get(commandProjectId);
    if (!project) {
      return rejected('unknownProject', `Unknown project ${commandProjectId}`);
    }
    const resolved = resolveDirectory(directory);
    if (resolved === null) {
      return rejected('invalidCommand', 'Project directory must exist');
    }
    if (
      [...this.bus.state.projects.values()].some(
        (other) => other.id !== commandProjectId && sameDirectory(other.directory, resolved),
      )
    ) {
      return rejected('invalidCommand', `Directory '${resolved}' is already linked`);
    }
    if (sameDirectory(project.directory, resolved)) {
      return ok();
    }
    await this.bus.publish(commandProjectId, 'projectDirectoryChanged', {
      projectId: commandProjectId,
      directory: resolved,
    });
    return ok();
  }

  private async activateProject(projectId: string): Promise<CommandOutcome> {
    if (!this.bus.state.projects.has(projectId)) {
      return rejected('unknownProject', `Unknown project ${projectId}`);
    }
    await this.bus.publish(projectId, 'projectActivated', { projectId });
    return ok();
  }
}

function ok(): CommandOutcome {
  return { ok: true };
}

function rejected(code: Rejection['code'], message: string): CommandOutcome {
  return { ok: false, rejection: { code, message } };
}

/** One past the highest numeric suffix in use ("P-3" → "P-4"). */
function allocateId(ids: Iterable<string>, prefix: string): string {
  let max = 0;
  for (const id of ids) {
    const match = /^[A-Z]+-(\d+)$/.exec(id);
    if (match && match[1] !== undefined) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return `${prefix}-${max + 1}`;
}

/** Resolves a directory-ish string to an existing absolute path, else null. */
function resolveDirectory(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return null;
  const path = isAbsolute(value) ? value : join(process.cwd(), value);
  const normalized = normalize(path).replace(/[/\\]+$/, '');
  try {
    return statSync(normalized).isDirectory() ? normalized : null;
  } catch {
    return null;
  }
}

function sameDirectory(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  return trimEndingSeparator(left) === trimEndingSeparator(right);
}

function trimEndingSeparator(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  return trimmed === '' ? path : trimmed;
}
