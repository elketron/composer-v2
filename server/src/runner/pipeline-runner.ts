// Coordinates runner subscription and live task lifecycles. Frame handling
// and pipeline execution live in leaf modules.

import type { Bus } from '../bus.js';
import { Board } from '../domain/board.js';
import type { AgentEngine } from '../engine/types.js';
import { AUTO_RUN_CAP, laneAutomated, laneIsBacklog } from './automation.js';
import { drivePipeline } from './drive.js';
import { handleFrame, type AutomationHooks } from './frame-handler.js';
import type { RunTask, RunnerOptions } from './types.js';

export type { RunnerOptions } from './types.js';

export class PipelineRunner {
  private readonly bus: Bus;
  private readonly engine: AgentEngine;
  private readonly options: Required<Pick<RunnerOptions, 'commandTimeoutMs' | 'agentTimeoutMs'>> & RunnerOptions;
  private readonly tasks = new Map<string, RunTask>();
  /** Per card (projectId/cardId): consecutive automated runs without a completion. */
  private readonly autoRuns = new Map<string, number>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    bus: Bus,
    engine: AgentEngine,
    options: RunnerOptions = {},
  ) {
    this.bus = bus;
    this.engine = engine;
    this.options = {
      commandTimeoutMs: options.commandTimeoutMs ?? 600_000,
      agentTimeoutMs: options.agentTimeoutMs ?? 600_000,
      ...options,
    };
  }

  start(): void {
    this.unsubscribe = this.bus.subscribe((frame) => {
      void handleFrame(
        this.bus,
        this.tasks,
        (projectId, runId, cardId, pipelineId, revision) =>
          this.startRun(projectId, runId, cardId, pipelineId, revision),
        {
          automated: (projectId, pipelineId, laneId) =>
            laneAutomated(this.bus, projectId, pipelineId, laneId),
          parked: (projectId, pipelineId, laneId) =>
            laneIsBacklog(this.bus, projectId, pipelineId, laneId),
          kick: (projectId, cardId) => this.scheduleAutoRun(projectId, cardId),
          reset: (projectId, cardId) => {
            this.autoRuns.delete(`${projectId}/${cardId}`);
          },
        },
        frame,
      ).catch((error) => console.error('runner:', error));
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.autoRuns.clear();
    for (const task of this.tasks.values()) {
      task.stopped = true;
      task.abort.abort();
      task.child?.cancel();
      task.resolveGate?.('cancelled');
    }
    // The tasks stay in the map: each drive removes its own task in its
    // finally, which is exactly the unwind signal drain() waits on.
  }

  // Resolves once every started run has fully unwound (the task leaves the
  // map only after drive's last publish resolved) — teardown uses this so
  // no in-flight append races a closing EventStore.
  async drain(): Promise<void> {
    while (this.tasks.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  private async startRun(
    projectId: string,
    runId: string,
    cardId: string,
    pipelineId: string,
    revision: number | undefined,
  ): Promise<void> {
    if (this.tasks.has(runId)) return;
    const project = this.bus.state.byProject.get(projectId);
    if (project === undefined) return;
    // The pinned revision wins; a revision the fold no longer holds (or an
    // unnumbered run) falls back to the pipeline's current definition.
    const pipeline = Board.of(project).pipelineOfRun({ pipelineId, revision: revision ?? 0 });
    if (pipeline === undefined) return;
    const task: RunTask = {
      projectId,
      runId,
      cardId,
      pipelineId,
      stopped: false,
      child: null,
      abort: new AbortController(),
      resolveGate: null,
      outcome: null,
    };
    this.tasks.set(runId, task);
    try {
      await drivePipeline(this.bus, this.engine, this.options, task, pipeline);
    } finally {
      this.tasks.delete(runId);
    }
  }

  /**
   * The lane automation's auto-run: a validated run for the card, deferred
   * one tick so a routed return's `pipelineRunEnded` lands first (the
   * previous run must not still hold the card). A per-card budget caps a
   * rework loop that never converges; a completed run re-arms it.
   */
  private scheduleAutoRun(projectId: string, cardId: string): void {
    const kick = this.options.runCard;
    if (kick === undefined) return;
    const key = `${projectId}/${cardId}`;
    const next = (this.autoRuns.get(key) ?? 0) + 1;
    if (next > AUTO_RUN_CAP) {
      console.warn(
        `runner: automation cap (${AUTO_RUN_CAP} runs) reached for card ${cardId} in ${projectId} — waiting for a completed run or a manual nudge`,
      );
      return;
    }
    this.autoRuns.set(key, next);
    setTimeout(() => {
      void Promise.resolve(kick(projectId, cardId)).catch((error) =>
        console.error('runner: automated run failed:', error),
      );
    }, 0);
  }
}
