// The pipeline runner's shared types: the constructor options, one live
// run's coordination state, the gate decision, and the agent outcome
// report (S36).

export interface RunnerOptions {
  /** Composer's HTTP base (the Composer tools' callback target). */
  serverUrl?: string;
  /** Wall-clock cap per command step (default 10 minutes). */
  commandTimeoutMs?: number;
  /** Wall-clock cap per agent step (default 10 minutes). */
  agentTimeoutMs?: number;
  /** The settings provider — the model override rides each agent step's spec. */
  getModel?: () => Promise<{ model?: string }> | { model?: string };
  /** Runs before each agent step (extra provisioning; none by default). */
  provision?: (directory: string) => void;
  /**
   * Kicks a validated pipeline run for a card (the lane automation's
   * auto-run); absent when no automation behavior is wanted.
   */
  runCard?: (projectId: string, cardId: string) => Promise<unknown>;
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

/** An opaque handle to the command step's live child, with cancel only. */
export interface CommandHandle {
  cancel(): void;
}

/** One live run: the drive task's coordination state. */
export interface RunTask {
  projectId: string;
  runId: string;
  cardId: string;
  pipelineId: string;
  stopped: boolean;
  child: CommandHandle | null;
  abort: AbortController;
  resolveGate: ((decision: GateDecision | 'cancelled') => void) | null;
  /** The agent's reported outcome for the current step, if one landed. */
  outcome: OutcomeReport | null;
}
