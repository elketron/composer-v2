// The processor's command vocabulary: how a typed command handler is
// registered (the `command` wrapper narrows the union by the command's
// type), the outcome builders, the typed-rejection mapping, and the id
// allocator every domain shares.

import type { Command, CommandOutcome, Rejection } from '../wire/commands.js';
import { CommandRejection } from '../domain/rejection.js';
import type { Board } from '../domain/board.js';
import type { Processor } from './index.js';

/** A command handler: one entry of the processor's dispatch map. */
export type CommandRun = (p: Processor, scope: string | undefined, command: Command) => Promise<CommandOutcome>;

export type CommandMap = Array<[string, CommandRun]>;

/**
 * Registers one command type: the handler receives the command narrowed to
 * its member of the union — no casts inside the handler.
 */
export function command<T extends Command['type']>(
  type: T,
  run: (p: Processor, scope: string | undefined, cmd: Extract<Command, { type: T }>) => Promise<CommandOutcome>,
): [string, CommandRun] {
  return [type, (p, scope, cmd) => run(p, scope, cmd as Extract<Command, { type: T }>)];
}

export function ok(): CommandOutcome {
  return { ok: true };
}

export function rejected(code: Rejection['code'], message: string): CommandOutcome {
  return { ok: false, rejection: { code, message } };
}

/** A transition's typed rejection becomes the wire outcome unchanged. */
export function toRejection(error: unknown): CommandOutcome {
  if (error instanceof CommandRejection) return rejected(error.code, error.message);
  throw error;
}

export function isOutcome(value: Board | CommandOutcome): value is CommandOutcome {
  return 'ok' in value;
}

/** One past the highest numeric suffix in use ("P-3" → "P-4"). */
export function allocateId(ids: Iterable<string>, prefix: string): string {
  let max = 0;
  for (const id of ids) {
    const match = /^[A-Z]+-(\d+)$/.exec(id);
    if (match && match[1] !== undefined) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return `${prefix}-${max + 1}`;
}
