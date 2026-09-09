// The board — a project's aggregate of linked objects, used as a *read*
// facade. The fold's ProjectState holds the maps; the Board answers the
// cross-object questions in one place: which pipeline a card is assigned
// to, which run is active on a card, which pipeline revision a run pinned,
// whether a card is done or blocked, a card's latest run. The processor,
// the runner, the snapshot, and the view shaping all read these rules from
// here instead of re-deriving them from the maps.
//
// The card transitions and the run/outcome policies no longer live here:
// they answer commands with events, so they sit in `card-transitions.ts`
// and `run-policy.ts` over the same ProjectState view (SRV-007).

import type { ProjectState } from '../fold/index.js';
import { DEFAULT_PIPELINE_ID } from '../pipelines.js';
import { CommandRejection } from './rejection.js';
import { isBlockedIn, Card } from './card.js';
import type { Pipeline } from './pipeline.js';
import type { Run } from './run.js';

export class Board {
  private constructor(private readonly project: ProjectState) {}

  static of(project: ProjectState): Board {
    return new Board(project);
  }

  card(id: string): Card | undefined {
    return this.project.cards.get(id);
  }

  get cards(): ReadonlyMap<string, Card> {
    return this.project.cards;
  }

  pipeline(id: string): Pipeline | undefined {
    return this.project.pipelines.get(id);
  }

  /** The pipeline a card is assigned to (the card's step is one of its steps). */
  pipelineOf(card: Pick<Card, 'pipelineId'>): Pipeline | undefined {
    return this.project.pipelines.get(card.pipelineId);
  }

  run(id: string): Run | undefined {
    return this.project.runs.get(id);
  }

  get runs(): ReadonlyMap<string, Run> {
    return this.project.runs;
  }

  /** The card's active run, if any (at most one). */
  activeRun(cardId: string): Run | undefined {
    const runId = this.project.activeRuns.get(cardId);
    return runId !== undefined ? this.project.runs.get(runId) : undefined;
  }

  /**
   * The pipeline revision a run pinned — an edited pipeline never changes a
   * live or historical run's rules. A revision the fold no longer holds (or
   * an unnumbered run) falls back to the pipeline's current definition.
   */
  pipelineOfRun(run: Pick<Run, 'pipelineId' | 'revision'>): Pipeline | undefined {
    return (
      this.project.pipelineRevisions.get(run.pipelineId)?.get(run.revision) ??
      this.project.pipelines.get(run.pipelineId)
    );
  }

  /** Whether a card sits at its pipeline's terminal (completion) step. */
  isDone(card: Pick<Card, 'pipelineId' | 'stepId'>): boolean {
    return this.pipelineOf(card)?.isTerminalStep(card.stepId) === true;
  }

  /** Blocked while any blocker exists and has not reached its own pipeline's terminal step. */
  isBlocked(card: Pick<Card, 'blockedBy'>): boolean {
    return isBlockedIn(this.project.cards, card, this.project.pipelines);
  }

  /** The card's most recent run by start time (any status), if one exists. */
  latestRunOf(cardId: string): Run | undefined {
    let latest: Run | undefined;
    for (const run of this.project.runs.values()) {
      if (run.cardId !== cardId) continue;
      if (latest === undefined || run.startedAt >= latest.startedAt) latest = run;
    }
    return latest;
  }

  /** The project's default pipeline: PL-1 when present, else the first by id. */
  defaultPipeline(): Pipeline | undefined {
    const pipelines = this.project.pipelines;
    if (pipelines.size === 0) return undefined;
    if (pipelines.has(DEFAULT_PIPELINE_ID)) return pipelines.get(DEFAULT_PIPELINE_ID);
    return pipelines.get([...pipelines.keys()].sort()[0]!);
  }

  // ---- Reads that reject ----
  // A command first reads the object it names; a miss here is the same
  // typed rejection the processor always emitted.

  /** The named card, or a rejection. */
  requireCard(cardId: string): Card {
    const card = this.project.cards.get(cardId);
    if (card === undefined) throw new CommandRejection('unknownCard', `Unknown card ${cardId}`);
    return card;
  }

  /** The pipeline a card is assigned to, or a rejection. */
  requirePipelineOf(card: Pick<Card, 'id' | 'pipelineId'>): Pipeline {
    const pipeline = this.pipelineOf(card);
    if (pipeline === undefined) throw new CommandRejection('unknownPipeline', `Card ${card.id} has no assigned pipeline`);
    return pipeline;
  }

  /** The card's active run, or a rejection (distinguishing an unknown card). */
  requireActiveRun(cardId: string): Run {
    const run = this.activeRun(cardId);
    if (run === undefined) {
      const unknown = this.project.cards.get(cardId) === undefined;
      throw new CommandRejection(
        unknown ? 'unknownCard' : 'pipelineNotRunning',
        unknown ? `Unknown card ${cardId}` : `Card ${cardId} has no running pipeline`,
      );
    }
    return run;
  }
}