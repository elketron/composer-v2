import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Parse the one `provider/model` id emitted on each line by `opencode models`. */
export function parseOpenCodeModels(output: string): string[] {
  return [
    ...new Set(
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[^\s/]+\/.+$/.test(line)),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

export async function listOpenCodeModels(): Promise<string[]> {
  const { stdout } = await execFileAsync('opencode', ['models'], {
    timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return parseOpenCodeModels(stdout);
}
