// The board — a project's aggregate of linked objects. The fold's
// ProjectState holds the maps; the Board is the object that answers the
// cross-object questions in one place: which pipeline a card is assigned
// to, which run is active on a card, which pipeline revision a run pinned,
// whether a card is done or blocked, a card's latest run. The processor,
// the runner, the snapshot, and the view shaping all read these rules from
// here instead of re-deriving them from the maps.

import type { ProjectState } from '../fold.js';
import { DEFAULT_PIPELINE_ID } from '../pipelines.js';
import { isBlockedIn } from './card.js';
import type { Card } from './card.js';
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

  /** The pipeline a card is assigned to (the card's stage is one of its stages). */
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

  /** Whether a card sits in its pipeline's terminal (completion) stage. */
  isDone(card: Pick<Card, 'pipelineId' | 'stageId'>): boolean {
    return this.pipelineOf(card)?.isTerminalStage(card.stageId) === true;
  }

  /** Blocked while any blocker exists and has not reached its own pipeline's terminal stage. */
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
}
