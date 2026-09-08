// The pipeline runner's shared types: the constructor options, one live
// run's coordination state, the gate decision, and the agent outcome
// report (S36).

import type { ChildProcess } from 'node:child_process';

export interface RunnerOptions {
  /** Composer's HTTP base (the MCP tools' callback target). */
  serverUrl?: string;
  /** Absolute path to the worker MCP server script (dist/mcp/worker.js). */
  mcpScriptPath?: string;
  /** Wall-clock cap per command step (default 10 minutes). */
  commandTimeoutMs?: number;
  /** Wall-clock cap per agent step (default 10 minutes). */
  agentTimeoutMs?: number;
  /** The settings provider — the model override rides each agent step's spec. */
  getModel?: () => Promise<{ model?: string }> | { model?: string };
}

export interface GateDecision {
  approved: boolean;
  comment?: string;
}

/** One outcome report recorded for the run's current agent step (S36). */
export interface OutcomeReport {
  stepId: string;
  outcome: string;
  note?: string;
}

/** One live run: the drive task's coordination state. */
export interface RunTask {
  projectId: string;
  runId: string;
  cardId: string;
  pipelineId: string;
  stopped: boolean;
  child: ChildProcess | null;
  abort: AbortController;
  resolveGate: ((decision: GateDecision | 'cancelled') => void) | null;
  /** The agent's reported outcome for the current step, if one landed. */
  outcome: OutcomeReport | null;
}
