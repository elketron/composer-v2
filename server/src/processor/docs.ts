// The docs domain's commands (Phase 9): the project's markdown docs. Each
// command resolves the linked project directory, writes through the docs
// repository, and publishes metadata-only events (the content never rides
// the log). The compensation is `commitFile` — a failed publish rolls the
// file write back.

import type { CommandOutcome } from '../wire/commands.js';
import { command, ok, type CommandMap } from './helpers.js';
import { commitFile, directoryOf } from './files-util.js';
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
  return commitFile(
    () => p.files.docs.save(directory, path, content),
    async (doc) => p.bus.publish(scope!, 'docSaved', { doc }),
  );
}

/** Deletes one doc; the tombstone is project-scoped, by path. */
export async function deleteDoc(p: Processor, scope: string | undefined, path: string): Promise<CommandOutcome> {
  const directory = directoryOf(p, scope);
  if (typeof directory !== 'string') return directory;
  return commitFile(
    () => p.files.docs.remove(directory, path),
    async () => p.bus.publish(scope!, 'docDeleted', { path }),
  );
}

/**
 * Renames one doc (a single on-disk rename): the new metadata lands as
 * docSaved before the old path's docDeleted, so folds see an upsert then
 * the tombstone in either order. Same path is a no-op.
 */
export async function renameDoc(p: Processor, scope: string | undefined, path: string, to: string): Promise<CommandOutcome> {
  const directory = directoryOf(p, scope);
  if (typeof directory !== 'string') return directory;
  if (path === to) return ok();
  return commitFile(
    () => p.files.docs.rename(directory, path, to),
    async (doc) => {
      await p.bus.publish(scope!, 'docSaved', { doc });
      await p.bus.publish(scope!, 'docDeleted', { path });
    },
  );
}

export const docCommands: CommandMap = [
  command('requestDocSave', (p, scope, cmd) => saveDoc(p, scope, cmd.path, cmd.content)),
  command('requestDocRename', (p, scope, cmd) => renameDoc(p, scope, cmd.path, cmd.to)),
  command('requestDocDelete', (p, scope, cmd) => deleteDoc(p, scope, cmd.path)),
];