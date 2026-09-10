// The project justfile's recipes (the editor's "just recipe" presets and
// the Set step column): `just --list` is the canonical surface — its lines
// carry the name, the parameter signature, and the trailing comment. When
// the `just` binary is unavailable, a direct parse of the justfile text
// fills in (recipes at column 0, assignments/aliases excluded).

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/** One justfile recipe the editor can turn into a `just <name>` step. */
export interface JustRecipe {
  name: string;
  description: string;
}

/** The justfile names just reads (also the hidden `.justfile`). */
const JUSTFILE_NAMES = ['justfile', '.justfile'] as const;

const LIST_LINE = /^(\S+)\s*([^#]*)(?:#\s*(.*))?$/;

/**
 * The recipes of the project's justfile (absent file or unreadable content
 * answers an empty list — the presets simply don't render).
 */
export async function justfileRecipes(directory: string | undefined): Promise<JustRecipe[]> {
  if (directory === undefined || directory === '') return [];
  const root = directory.replace(/[\\/]+$/, '');
  const listed = await listRecipes(root);
  if (listed !== null) return listed;
  for (const name of JUSTFILE_NAMES) {
    let contents: string;
    try {
      contents = await readFile(`${root}/${name}`, 'utf8');
    } catch {
      continue;
    }
    const recipes = parseJustfile(contents);
    if (recipes !== null) return recipes;
  }
  return [];
}

/**
 * The `just --list` recipes (null when the binary is missing or the
 * directory is not a just project — the caller falls back to the parse).
 */
async function listRecipes(root: string): Promise<JustRecipe[] | null> {
  const { stdout, ran } = await new Promise<{ stdout: string; ran: boolean }>((resolve) => {
    execFile(
      'just',
      ['--list', '--unsorted', '--list-heading', '', '--list-prefix', ''],
      { cwd: root, maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve({ stdout: typeof stdout === 'string' ? stdout : '', ran: error === null }),
    );
  });
  if (!ran) return null;
  const recipes: JustRecipe[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const match = LIST_LINE.exec(trimmed);
    if (match === null) continue;
    const [, name = '', signature = '', trailing] = match;
    // A required parameter would make bare `just <name>` fail; recipes
    // whose parameters all carry defaults (or are variadic) stay.
    if (takesArguments(signature.trim())) continue;
    recipes.push({ name, description: (trailing ?? '').trim() });
  }
  return recipes.length > 0 ? recipes : null;
}

/** The recipes in one justfile's text (null when the text parses to nothing). */
export function parseJustfile(contents: string): JustRecipe[] | null {
  const recipes: JustRecipe[] = [];
  const comments: string[] = [];
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      // A full-line comment feeds the next recipe's description.
      comments.push(trimmed.replace(/^#\s*/, ''));
      continue;
    }
    // Recipe bodies and shebangs are indented; headers start at column 0.
    if (line.startsWith(' ') || line.startsWith('\t')) continue;

    const header = HEADER.exec(line);
    if (header === null) {
      // Anything else at column 0 (attributes, broken lines) resets the
      // comment block rather than feeding it forward.
      comments.length = 0;
      continue;
    }
    const [, , name, rawParams = '', after = ''] = header;
    const pendingComments = comments.filter((entry) => entry !== '');
    comments.length = 0;
    // `x := …` (assignments, aliases) puts the `=` right after the colon.
    if (after.startsWith('=')) continue;
    // A required parameter would make bare `just <name>` fail; recipes
    // whose parameters all carry defaults (or are variadic) stay.
    if (takesArguments(rawParams.trim())) continue;
    const hash = after.indexOf('#');
    const trailing = hash >= 0 ? after.slice(hash + 1).trim() : '';
    const description = trailing !== '' ? trailing : pendingComments.join(' ').trim();
    recipes.push({ name: name ?? '', description });
  }
  return recipes.length > 0 ? recipes : null;
}

const HEADER = /^([@+\-]*)([a-zA-Z_][a-zA-Z0-9_-]*)((?:\s+[^:#]*)?):(.*)$/;

/**
 * Whether the parameter list would make a bare `just <name>` fail: a
 * parameter without a default (variadic `+`/`*` lists included) counts.
 */
function takesArguments(params: string): boolean {
  return (
    params
      .split(/\s+/)
      .filter((param) => param !== '' && !param.includes('=') && !/^[*+]/.test(param)).length > 0
  );
}
