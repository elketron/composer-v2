// The card (dual representation): the class owns the card's representation —
// `fromWire` builds it from the wire shape, `toWire()` emits it back — and
// its state is immutable: the fold replaces instances with `with()` instead
// of mutating them, so state can be shared without defensive clones. The
// blocking rule lives here as the one definition the processor's command
// validation and the snapshot's dependency replay both answer; the
// cross-object rules that need the whole board join with the aggregate.

import {
  readNumber,
  readObject,
  readString,
  readStringArray,
  asRecord,
} from '../wire/read.js';
import type {
  Assignee,
  Card as CardJson,
  CardType,
  FileStats,
  Pipeline as PipelineJson,
  SubStateStatus,
} from '../wire/models.js';

/** The board's unit of work: one card of a project, assigned to one pipeline. */
export class Card {
  readonly id: string;
  readonly projectId: string;
  readonly type: CardType;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  /** The one pipeline the card is assigned to; it appears on that pipeline's board tab. */
  readonly pipelineId: string;
  /** The card's current lane of its assigned pipeline (the board shows it there). */
  readonly laneId: string;
  readonly blockedBy: readonly string[];
  readonly assignee?: Assignee;
  readonly sessionId?: string;
  readonly branch?: string;
  readonly fileStats?: FileStats;
  /** Per-step execution state, keyed by the assigned pipeline's step ids. */
  readonly stepStates: Readonly<Record<string, SubStateStatus>>;
  readonly rejectionComment?: string;
  readonly createdAt: string;
  readonly updatedAt: string;

  constructor(json: CardJson) {
    this.id = json.id;
    this.projectId = json.projectId;
    this.type = json.type;
    this.title = json.title;
    this.description = json.description;
    this.tags = [...json.tags];
    this.pipelineId = json.pipelineId;
    this.laneId = json.laneId;
    this.blockedBy = [...json.blockedBy];
    if (json.assignee !== undefined) this.assignee = { ...json.assignee };
    if (json.sessionId !== undefined) this.sessionId = json.sessionId;
    if (json.branch !== undefined) this.branch = json.branch;
    if (json.fileStats !== undefined) this.fileStats = { ...json.fileStats };
    this.stepStates = { ...json.stepStates };
    if (json.rejectionComment !== undefined) this.rejectionComment = json.rejectionComment;
    this.createdAt = json.createdAt;
    this.updatedAt = json.updatedAt;
  }

  static fromWire(json: CardJson): Card {
    return new Card(json);
  }

  /**
   * The card the client meant — every field lenient, defaults where absent.
   * Empty pipeline/step ids let the processor assign the defaults.
   */
  static fromAction(json: unknown, scopeProjectId: string | undefined): CardJson {
    const record = asRecord(json);
    const str = (key: string): string | undefined => readString(record, key);
    const assigneeJson = readObject(record, 'assignee');
    const assigneeRole = readString(assigneeJson ?? {}, 'role') ?? 'human';
    const fileStats = readObject(record, 'fileStats');
    const createdAt = str('createdAt');
    const updatedAt = str('updatedAt');
    const created = createdAt !== undefined && Date.parse(createdAt) > 0 ? createdAt : '';
    const updated = updatedAt !== undefined && Date.parse(updatedAt) > 0 ? updatedAt : '';
    return {
      id: str('id') ?? '',
      projectId: str('projectId') ?? scopeProjectId ?? '',
      type: parseCardType(str('type') ?? 'coding'),
      title: str('title') ?? '',
      description: str('description') ?? '',
      tags: readStringArray(record, 'tags'),
      pipelineId: str('pipelineId') ?? '',
      laneId: str('laneId') ?? str('stepId') ?? '',
      blockedBy: readStringArray(record, 'blockedBy'),
      ...(assigneeJson !== undefined
        ? {
            assignee:
              assigneeRole === 'human'
                ? { role: 'human' }
                : {
                    role: assigneeRole,
                    ...(readString(assigneeJson, 'model') ? { model: readString(assigneeJson, 'model') } : {}),
                    ...(readString(assigneeJson, 'effort') ? { effort: readString(assigneeJson, 'effort') } : {}),
                  },
          }
        : {}),
      ...(str('sessionId') !== undefined ? { sessionId: str('sessionId') } : {}),
      ...(str('branch') !== undefined ? { branch: str('branch') } : {}),
      ...(fileStats !== undefined
        ? {
            fileStats: {
              added: readNumber(fileStats, 'added'),
              removed: readNumber(fileStats, 'removed'),
              files: readNumber(fileStats, 'files'),
            },
          }
        : {}),
      stepStates: readStepStates(record),
      ...(str('rejectionComment') !== undefined ? { rejectionComment: str('rejectionComment') } : {}),
      createdAt: created,
      updatedAt: updated,
    };
  }

  toWire(): CardJson {
    return {
      id: this.id,
      projectId: this.projectId,
      type: this.type,
      title: this.title,
      description: this.description,
      tags: [...this.tags],
      pipelineId: this.pipelineId,
      laneId: this.laneId,
      blockedBy: [...this.blockedBy],
      ...(this.assignee !== undefined ? { assignee: { ...this.assignee } } : {}),
      ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
      ...(this.branch !== undefined ? { branch: this.branch } : {}),
      ...(this.fileStats !== undefined ? { fileStats: { ...this.fileStats } } : {}),
      stepStates: { ...this.stepStates },
      ...(this.rejectionComment !== undefined ? { rejectionComment: this.rejectionComment } : {}),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  /**
   * Copy with changes applied. A change set to undefined drops the field —
   * the absent-optional wire rule — so unassignment and clearing ride the
   * same path as assignment.
   */
  with(changes: Partial<CardJson>): Card {
    const merged: Record<string, unknown> = { ...this.toWire() };
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete merged[key];
      else merged[key] = value;
    }
    return new Card(merged as unknown as CardJson);
  }
}

/**
 * Blocked while any blocker exists and has not reached its own pipeline's
 * terminal stage. The one definition: a missing blocker never blocks (an
 * archived dependency releases the card), and only the blocker's own
 * pipeline decides its done-ness.
 */
export function isBlockedIn(
  cardsById: ReadonlyMap<string, CardJson>,
  card: Pick<CardJson, 'blockedBy'>,
  pipelines: ReadonlyMap<string, PipelineJson>,
): boolean {
  return card.blockedBy.some((id) => {
    const blocker = cardsById.get(id);
    if (blocker === undefined) return false;
    return pipelines.get(blocker.pipelineId)?.lanes.find((lane) => lane.id === blocker.laneId)?.terminal !== true;
  });
}

export function parseCardType(value: string | undefined): CardType {
  return value === 'design' || value === 'docs' ? value : 'coding';
}

export function parseSubStateStatus(value: string | undefined): SubStateStatus {
  return value === 'running' || value === 'ok' || value === 'failed' ? value : 'pending';
}

function readStepStates(record: Record<string, unknown>): Record<string, SubStateStatus> {
  const json = readObject(record, 'stepStates');
  if (json === undefined) return {};
  const result: Record<string, SubStateStatus> = {};
  for (const [key, value] of Object.entries(json)) {
    result[key] = parseSubStateStatus(typeof value === 'string' ? value : 'pending');
  }
  return result;
}
