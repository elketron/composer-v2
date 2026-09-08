// The command step body: one child process in the project directory,
// output captured (live lines ride ephemeral `commandOutput` events, capped
// so a chatty build cannot flood the stream), and a wall-clock kill.

import { spawn } from 'node:child_process';
import type { Bus } from '../bus.js';
import type { PipelineStep } from '../wire/models.js';
import type { RunTask } from './types.js';

export type CommandStepResult = { ok: true } | { ok: false; error: string };

export async function runCommandStep(
  bus: Bus,
  task: RunTask,
  step: PipelineStep,
  commandTimeoutMs: number,
): Promise<CommandStepResult> {
  // A stop that landed while the drive was between awaits must not spawn
  // a child nobody will kill.
  if (task.stopped) return { ok: false, error: 'the run was stopped' };
  const directory = bus.state.projects.get(task.projectId)?.directory;
  if (directory === undefined) {
    return { ok: false, error: `Project ${task.projectId} has no directory set` };
  }
  return await new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', step.command ?? ''], { cwd: directory });
    task.child = child;
    let output = '';
    // Live output rides ephemeral `commandOutput` events (live-only, like
    // agent deltas) — capped so a chatty build can't flood the stream.
    const MAX_LIVE_LINES = 400;
    let liveLines = 0;
    let lineBuffer = '';
    const streamLines = (chunk: string): void => {
      lineBuffer += chunk;
      let index: number;
      while ((index = lineBuffer.indexOf('\n')) >= 0) {
        const line = lineBuffer.slice(0, index);
        lineBuffer = lineBuffer.slice(index + 1);
        if (liveLines < MAX_LIVE_LINES) {
          liveLines++;
          void bus
            .publish(task.projectId, 'commandOutput', {
              runId: task.runId,
              cardId: task.cardId,
              pipelineId: task.pipelineId,
              stepId: step.id,
              line,
            })
            .catch(() => undefined);
        }
      }
    };
    const capture = (chunk: Buffer): void => {
      const text = chunk.toString();
      output = (output + text).slice(-8_000);
      streamLines(text);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    const timeout = setTimeout(() => child.kill('SIGKILL'), commandTimeoutMs);
    timeout.unref?.();
    child.on('error', (error) => {
      clearTimeout(timeout);
      resolve({ ok: false, error: `command failed to start: ${String(error)}` });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      task.child = null;
      if (task.stopped) {
        resolve({ ok: false, error: 'the run was stopped' });
        return;
      }
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      const detail = output.trim().split('\n').at(-1) ?? '';
      const reason = signal !== null ? `killed by ${signal}` : `exit code ${code}`;
      resolve({ ok: false, error: detail !== '' ? `${reason}: ${detail}` : reason });
    });
  });
}
