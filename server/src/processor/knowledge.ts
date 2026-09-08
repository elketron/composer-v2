// The knowledge domain's commands (Phase 9): global writes over the
// data-dir library, project-agnostic. Writes go through the injected
// `KnowledgeStore` (a port); the metadata-only events publish on the global
// stream with `commitFile` compensation.

import type { CommandOutcome } from '../wire/commands.js';
import { command, rejected, type CommandMap } from './helpers.js';
import { commitFile } from './files-util.js';
import type { Processor } from './index.js';

/**
 * Saves a note: with a path the content is the exact file (the desktop's
 * edit flow), without one title/tags frontmatter it and a unique slug
 * filename (the agent's save tool).
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
  return commitFile(
    () =>
      command.path !== undefined && command.path.trim() !== ''
        ? p.knowledge!.saveToFile(command.path, command.content)
        : p.knowledge!.createEntry({
            title: command.title ?? '',
            tags: command.tags,
            content: command.content,
          }),
    async (entry) => p.bus.publish(undefined, 'knowledgeSaved', { entry }),
    (entry) => ({ ok: true, savedPath: entry.path }),
  );
}

/** Deletes one note; the tombstone is global, by path. */
export async function deleteKnowledge(p: Processor, path: string): Promise<CommandOutcome> {
  if (p.knowledge === undefined) {
    return rejected('invalidCommand', 'knowledge storage is unavailable');
  }
  return commitFile(
    () => p.knowledge!.delete(path),
    async () => p.bus.publish(undefined, 'knowledgeDeleted', { path }),
  );
}

export const knowledgeCommands: CommandMap = [
  command('requestKnowledgeSave', (p, _scope, cmd) => saveKnowledge(p, cmd)),
  command('requestKnowledgeDelete', (p, _scope, cmd) => deleteKnowledge(p, cmd.path)),
];