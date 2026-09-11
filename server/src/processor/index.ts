// The processor: the one validated write path (v1 architecture.md §Server
// command validation). The command handlers live in the domain modules
// beside their objects — projects, cards, pipelines, planning, threads,
// proposals, docs, knowledge, workflows — and this class is the composition
// root: the state the handlers share (the bus, the knowledge store, the
// file repositories, the workflow recordings), the lookup helpers, and the
// dispatch. The dispatch is a map of command type → handler, not a switch;
// each handler returns the wire outcome, and its rejections carry the same
// codes and messages the validation rules on the objects emit.

import type { Bus } from '../bus.js';
import type { Command, CommandOutcome } from '../wire/commands.js';
import type {
  AssistantThread,
  PlanningSession,
} from '../wire/models.js';
import { Card } from '../domain/card.js';
import { Diagram } from '../domain/diagram.js';
import { Pipeline } from '../domain/pipeline.js';
import type { Run } from '../domain/run.js';
import { Board } from '../domain/board.js';
import { deleteDoc, renameDoc, saveDoc } from '../docs/index.js';
import { deleteWorkflow, saveWorkflow } from '../workflows.js';
import { rejected } from './helpers.js';
import { cardCommands } from './cards.js';
import { diagramCommands } from './diagrams.js';
import { docCommands } from './docs.js';
import { knowledgeCommands } from './knowledge.js';
import { pipelineCommands } from './pipelines.js';
import { planningCommands } from './planning.js';
import { projectCommands } from './projects.js';
import { proposalCommands } from './proposals.js';
import { threadCommands } from './threads.js';
import { workflowCommands } from './workflows.js';
import { WorkflowRecordings } from './recordings.js';
import type { FileRepositories } from './ports.js';
import { makeDirectoryResolver, type DirectoryResolver } from '../filesystem/directory.js';
import type { KnowledgeStore } from '../knowledge.js';

/** Every registered command type → its handler. */
const commands = new Map<string, (p: Processor, scope: string | undefined, command: Command) => Promise<CommandOutcome>>([
  ...projectCommands,
  ...cardCommands,
  ...planningCommands,
  ...pipelineCommands,
  ...threadCommands,
  ...proposalCommands,
  ...docCommands,
  ...knowledgeCommands,
  ...workflowCommands,
  ...diagramCommands,
]);

export class Processor {
  /** internal — shared with the command modules */
  readonly bus: Bus;
  /** The knowledge library (Phase 9); absent only in narrow unit tests. */
  readonly knowledge?: KnowledgeStore;
  /** The docs and workflow repositories (ports, not concrete filesystems). */
  readonly files: FileRepositories;
  /** The open workflow recordings (S34), keyed by `<projectId>/<sessionId>`. */
  readonly recordings: WorkflowRecordings;
  /** Canonicalizes a directory string (the project commands link it). */
  readonly resolveDirectory: DirectoryResolver;

  constructor(
    bus: Bus,
    knowledge?: KnowledgeStore,
    files?: FileRepositories,
    recordings?: WorkflowRecordings,
    resolveDirectory?: DirectoryResolver,
  ) {
    this.bus = bus;
    this.knowledge = knowledge;
    this.files = files ?? {
      docs: { save: saveDoc, rename: renameDoc, remove: deleteDoc },
      workflows: { save: saveWorkflow, remove: deleteWorkflow },
    };
    this.recordings = recordings ?? new WorkflowRecordings();
    this.resolveDirectory = resolveDirectory ?? makeDirectoryResolver(process.cwd());
  }

  /**
   * Validates a command in the given project scope and, on success,
   * publishes the canonical events (persisted, folded, fanned out) before
   * resolving.
   */
  async execute(projectId: string | undefined, command: Command): Promise<CommandOutcome> {
    if (
      projectId !== undefined &&
      command.type !== 'requestProjectArchive' &&
      command.type !== 'requestProjectRestore' &&
      this.bus.state.projects.get(projectId)?.isArchived
    ) {
      return rejected('invalidCommand', `Project ${projectId} is archived`);
    }

    const run = commands.get(command.type);
    if (run === undefined) {
      return rejected('invalidCommand', `${command.type} is not implemented yet`);
    }
    return run(this, projectId, command);
  }

  // ---- Lookups the command modules share ----

  /**
   * The project's cards as a scratch map: a shallow copy of the fold's map —
   * the immutable instances are shared, and in-flight batches (a card the
   * next card in the batch may block on) mutate the copy, never the state.
   */
  cardsOf(projectId: string): Map<string, Card> {
    const cards = this.bus.state.byProject.get(projectId)?.cards;
    return cards !== undefined ? new Map(cards) : new Map();
  }

  sessionsOf(projectId: string): Map<string, PlanningSession> {
    return this.bus.state.byProject.get(projectId)?.planningSessions ?? new Map();
  }

  findSession(
    scope: string | undefined,
    sessionId: string,
  ): { projectId: string; session: PlanningSession } | null {
    if (scope === undefined) return null;
    const session = this.sessionsOf(scope).get(sessionId);
    return session ? { projectId: scope, session } : null;
  }

  pipelinesOf(projectId: string): Map<string, Pipeline> {
    return this.bus.state.byProject.get(projectId)?.pipelines ?? new Map();
  }

  runsOf(projectId: string): Map<string, Run> {
    return this.bus.state.byProject.get(projectId)?.runs ?? new Map();
  }

  diagramsOf(projectId: string): Map<string, Diagram> {
    return this.bus.state.byProject.get(projectId)?.diagrams ?? new Map();
  }

  /** The project's board (the aggregate the link rules are answered from). */
  boardOf(projectId: string): Board | undefined {
    const project = this.bus.state.byProject.get(projectId);
    return project !== undefined ? Board.of(project) : undefined;
  }

  /** The card's active run, if any (at most one). */
  activeRunOf(projectId: string | undefined, cardId: string): Run | null {
    return this.boardOf(projectId ?? '')?.activeRun(cardId) ?? null;
  }

  /** The project's default pipeline: PL-1 when present, else the first by id. */
  defaultPipelineOf(projectId: string): Pipeline | undefined {
    return this.boardOf(projectId)?.defaultPipeline();
  }

  assistantThreads(): Map<string, AssistantThread> {
    return this.bus.state.assistantThreads;
  }
}
