// The shared runners for the file-backed command modules (docs, knowledge,
// workflows). `directoryOf` resolves a command's linked project directory
// or its rejection; `commitFile` runs a repository mutation, publishes the
// metadata event(s), and rolls the file back if a publish fails (the
// SRV-003 compensation — a failed command leaves neither the file nor the
// event behind).

import type { MutationResult } from '../filesystem/commit.js';
import type { CommandOutcome } from '../wire/commands.js';
import { ok, rejected } from './helpers.js';
import type { Processor } from './index.js';

/**
 * The compensation runner: mutate the file, publish its event(s), and undo
 * the mutation if any publication fails. The repository threw already for a
 * storage failure; a `{ ok: false }` result is a validation rejection.
 */
export async function commitFile<T>(
  mutate: () => MutationResult<T>,
  publish: (value: T) => Promise<unknown>,
  outcome: (value: T) => CommandOutcome = () => ok(),
): Promise<CommandOutcome> {
  const result = mutate();
  if (!result.ok) return rejected('invalidCommand', result.error);
  try {
    await publish(result.value);
  } catch (error) {
    result.rollback();
    throw error;
  }
  return outcome(result.value);
}

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