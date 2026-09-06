// Wire types for the composer server's REST + SSE surface
// (docs/architecture.md). The contract is owned by the Rust serde models
// (`server/src/{models,events,http}.rs`): camelCase fields, enums as
// lowercase strings, RFC 3339 (microsecond) timestamps, absent optionals
// omitted. The golden fixture `wire-golden/events.json` at the repo root is
// asserted against on both sides (server test + this module's spec).
//
// This module holds the hand-written wire types, the enum const objects,
// the domain-model mapping, and the two shape conversions: SSE frame →
// oneof event (folds) and command DTO → action envelope (publish).

import {
  Assignee,
  Card,
  CardType,
  Lane,
  Stage,
  SubState,
  SubStateStage,
  SubStateStatus,
} from '../models/board.models';
import { PlanningSessionStatus } from '../models/plan.models';

// ---- Enum const objects (runtime values are the wire strings) ----

export const WireStage = {
  STAGE_NEW: 'new',
  STAGE_CODING: 'coding',
  STAGE_DESIGN: 'design',
  STAGE_DOCS: 'docs',
  STAGE_VALIDATION: 'validation',
  STAGE_REVIEW: 'review',
  STAGE_SECURITY: 'security',
  STAGE_APPROVAL: 'approval',
  STAGE_DONE: 'done',
} as const;
export type WireStage = (typeof WireStage)[keyof typeof WireStage];

export const WireCardType = {
  CARD_TYPE_CODING: 'coding',
  CARD_TYPE_DESIGN: 'design',
  CARD_TYPE_DOCS: 'docs',
} as const;
export type WireCardType = (typeof WireCardType)[keyof typeof WireCardType];

export const WireSubStateStatus = {
  SUB_STATE_STATUS_PENDING: 'pending',
  SUB_STATE_STATUS_RUNNING: 'running',
  SUB_STATE_STATUS_OK: 'ok',
  SUB_STATE_STATUS_FAILED: 'failed',
} as const;
export type WireSubStateStatus = (typeof WireSubStateStatus)[keyof typeof WireSubStateStatus];

export const WirePlanningSessionStatus = {
  PLANNING_SESSION_STATUS_DRAFTING: 'drafting',
  PLANNING_SESSION_STATUS_DONE: 'done',
} as const;
export type WirePlanningSessionStatus =
  (typeof WirePlanningSessionStatus)[keyof typeof WirePlanningSessionStatus];

export const WireAgentSessionStatus = {
  AGENT_SESSION_STATUS_RUNNING: 'running',
  AGENT_SESSION_STATUS_ENDED: 'ended',
  AGENT_SESSION_STATUS_FAILED: 'failed',
} as const;
export type WireAgentSessionStatus =
  (typeof WireAgentSessionStatus)[keyof typeof WireAgentSessionStatus];

export const WireRejectionCode = {
  REJECTION_CODE_UNKNOWN_PROJECT: 'unknownProject',
  REJECTION_CODE_UNKNOWN_CARD: 'unknownCard',
  REJECTION_CODE_UNKNOWN_SESSION: 'unknownSession',
  REJECTION_CODE_INVALID_LANE: 'invalidLane',
  REJECTION_CODE_BLOCKED: 'blocked',
  REJECTION_CODE_INVALID_TYPE: 'invalidType',
  REJECTION_CODE_INVALID_COMMAND: 'invalidCommand',
  REJECTION_CODE_UNKNOWN_PIPELINE: 'unknownPipeline',
  REJECTION_CODE_UNKNOWN_AGENT_KIND: 'unknownAgentKind',
  REJECTION_CODE_PIPELINE_ALREADY_RUNNING: 'pipelineAlreadyRunning',
  REJECTION_CODE_PIPELINE_NOT_RUNNING: 'pipelineNotRunning',
} as const;
export type WireRejectionCode = (typeof WireRejectionCode)[keyof typeof WireRejectionCode];

// ---- Entity shapes (mirror server/src/models.rs) ----

export interface AssigneeJson {
  readonly role?: string;
  readonly model?: string;
  readonly effort?: string;
}

export interface FileStatsJson {
  readonly added?: number;
  readonly removed?: number;
  readonly files?: number;
}

export interface CardJson {
  readonly id?: string;
  readonly projectId?: string;
  readonly type?: WireCardType;
  readonly title?: string;
  readonly description?: string;
  readonly tags?: string[];
  readonly stage?: WireStage;
  readonly blockedBy?: string[];
  readonly assignee?: AssigneeJson;
  readonly sessionId?: string;
  readonly branch?: string;
  readonly fileStats?: FileStatsJson;
  readonly subState?: Record<string, WireSubStateStatus>;
  readonly retries?: Record<string, number>;
  readonly rejectionComment?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface ChatMessageJson {
  readonly index?: number;
  readonly role?: string;
  readonly text?: string;
  readonly at?: string;
  readonly id?: string;
  readonly parentId?: string;
}

export interface PlanningSessionJson {
  readonly id?: string;
  readonly projectId?: string;
  readonly createdAt?: string;
  readonly status?: WirePlanningSessionStatus;
  readonly messages?: ChatMessageJson[];
  readonly planDocument?: string;
}

export interface ProjectJson {
  readonly id?: string;
  readonly name?: string;
  readonly directory?: string;
  readonly createdAt?: string;
  readonly archivedAt?: string;
}

export const WirePipelineStepKind = {
  PIPELINE_STEP_KIND_AGENT: 'agent',
  PIPELINE_STEP_KIND_COMMAND: 'command',
  PIPELINE_STEP_KIND_HUMAN: 'human',
} as const;
export type WirePipelineStepKind =
  (typeof WirePipelineStepKind)[keyof typeof WirePipelineStepKind];

export interface PipelineStepJson {
  readonly id: string;
  readonly kind: WirePipelineStepKind;
  readonly agentKind?: string;
  readonly instructions?: string;
  readonly command?: string;
  readonly description?: string;
  readonly retries?: number;
}

export interface PipelineJson {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly steps: PipelineStepJson[];
  readonly updatedAt: string;
}

export const WirePipelineRunStatus = {
  PIPELINE_RUN_STATUS_RUNNING: 'running',
  PIPELINE_RUN_STATUS_WAITING: 'waiting',
  PIPELINE_RUN_STATUS_COMPLETED: 'completed',
  PIPELINE_RUN_STATUS_FAILED: 'failed',
  PIPELINE_RUN_STATUS_CANCELLED: 'cancelled',
} as const;
export type WirePipelineRunStatus =
  (typeof WirePipelineRunStatus)[keyof typeof WirePipelineRunStatus];

export const WireAssistantThreadStatus = {
  ASSISTANT_THREAD_STATUS_IDLE: 'idle',
  ASSISTANT_THREAD_STATUS_RUNNING: 'running',
  ASSISTANT_THREAD_STATUS_FAILED: 'failed',
  ASSISTANT_THREAD_STATUS_STOPPED: 'stopped',
} as const;
export type WireAssistantThreadStatus =
  (typeof WireAssistantThreadStatus)[keyof typeof WireAssistantThreadStatus];

export type WireProposalStatus = 'drafted' | 'confirmed' | 'discarded';

export interface ProposalItemJson {
  readonly id?: string;
  readonly projectId?: string;
  readonly title?: string;
  readonly description?: string;
  readonly cardType?: WireCardType;
  readonly key?: string;
  readonly blockedBy?: string[];
  readonly included?: boolean;
}

export interface ProposalOutcomeJson {
  readonly projectId?: string;
  readonly ok?: boolean;
  readonly cardIds?: string[];
  readonly error?: string;
}

export interface CardProposalJson {
  readonly id?: string;
  readonly threadId?: string;
  readonly createdAt?: string;
  readonly status?: WireProposalStatus;
  readonly items?: ProposalItemJson[];
  readonly outcomes?: ProposalOutcomeJson[];
  readonly confirmedAt?: string;
}

export interface AssistantThreadJson {
  readonly id?: string;
  readonly name?: string;
  readonly createdAt?: string;
  readonly status?: WireAssistantThreadStatus;
  readonly projectIds?: string[];
  readonly archivedAt?: string;
  readonly messages?: ChatMessageJson[];
}

// ---- Events (server → client) ----

/** One SSE frame from `GET /events` (http.rs SseFrame). */
export interface EventFrameJson {
  readonly id: string;
  readonly projectId?: string;
  readonly occurredAt: string;
  readonly eventType: EventKind;
  readonly body: unknown;
}

/**
 * The oneof-shaped event the domain services fold. The transport converts an
 * EventFrameJson into this by moving `body` under its `eventType` key, so
 * folds read `event.cardCreated?.card` and friends.
 */
export interface DomainEventJson {
  readonly id?: string;
  readonly projectId?: string;
  readonly occurredAt?: string;
  readonly cardCreated?: { readonly card: CardJson };
  readonly cardMoved?: {
    readonly cardId: string;
    readonly from: WireStage;
    readonly to: WireStage;
    readonly comment?: string;
  };
  readonly cardTypeChanged?: {
    readonly cardId: string;
    readonly from: WireCardType;
    readonly to: WireCardType;
  };
  readonly cardAssigned?: {
    readonly cardId: string;
    readonly assignee?: AssigneeJson;
  };
  readonly cardArchived?: { readonly cardId: string };
  readonly subStateUpdated?: {
    readonly cardId: string;
    readonly stage: string;
    readonly status: WireSubStateStatus;
  };
  readonly dependencyStateChanged?: {
    readonly cardId: string;
    readonly blocked: boolean;
    readonly blockedBy: string[];
  };
  readonly automationToggled?: { readonly lane: WireStage; readonly on: boolean };
  readonly planningSessionCreated?: { readonly session: PlanningSessionJson };
  readonly userMessageReceived?: { readonly sessionId: string; readonly message: ChatMessageJson };
  readonly agentMessageDelta?: {
    readonly sessionId: string;
    readonly messageIndex: number;
    readonly delta: string;
  };
  readonly agentMessageComplete?: {
    readonly sessionId: string;
    readonly message: ChatMessageJson;
  };
  readonly planDocumentUpdated?: { readonly sessionId: string; readonly document: string };
  readonly planningSessionCompleted?: { readonly sessionId: string };
  readonly cardsCommitted?: { readonly cards: CardJson[] };
  readonly projectCreated?: { readonly project: ProjectJson };
  readonly projectDirectoryChanged?: { readonly projectId: string; readonly directory: string };
  readonly projectActivated?: { readonly projectId: string };
  readonly projectArchived?: { readonly projectId: string; readonly archivedAt: string };
  readonly projectRestored?: { readonly projectId: string; readonly restoredAt: string };
  readonly agentSessionStarted?: {
    readonly cardId: string;
    readonly sessionId: string;
    readonly agentKind: string;
    readonly startedAt: string;
  };
  readonly agentSessionEnded?: {
    readonly cardId: string;
    readonly sessionId: string;
    readonly status: WireAgentSessionStatus;
    readonly error?: string;
    readonly endedAt: string;
  };
  readonly agentToolCall?: {
    readonly sessionId: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly args: Record<string, unknown>;
  };
  readonly agentToolResult?: {
    readonly sessionId: string;
    readonly toolCallId: string;
    readonly content: string;
    readonly isError: boolean;
  };
  readonly pipelineSaved?: { readonly pipeline: PipelineJson };
  readonly pipelineDeleted?: { readonly pipelineId: string };
  readonly pipelineRunStarted?: { readonly cardId: string; readonly pipelineId: string };
  readonly pipelineStepStarted?: {
    readonly cardId: string;
    readonly pipelineId: string;
    readonly stepId: string;
    readonly kind: WirePipelineStepKind;
  };
  readonly pipelineStepFinished?: {
    readonly cardId: string;
    readonly pipelineId: string;
    readonly stepId: string;
    readonly ok: boolean;
    readonly error?: string;
  };
  readonly pipelineRunEnded?: {
    readonly cardId: string;
    readonly pipelineId: string;
    readonly status: WirePipelineRunStatus;
    readonly error?: string;
  };
  readonly pipelineGateResponded?: {
    readonly cardId: string;
    readonly approved: boolean;
    readonly comment?: string;
  };
  readonly commandOutput?: {
    readonly cardId: string;
    readonly pipelineId: string;
    readonly stepId: string;
    readonly line: string;
  };
  readonly assistantThreadCreated?: { readonly thread: AssistantThreadJson };
  readonly assistantThreadArchived?: { readonly threadId: string; readonly archivedAt: string };
  readonly assistantThreadRestored?: { readonly threadId: string; readonly restoredAt: string };
  readonly assistantThreadScopeChanged?: { readonly threadId: string; readonly projectIds: string[] };
  readonly assistantUserMessage?: { readonly threadId: string; readonly message: ChatMessageJson };
  readonly assistantMessageDelta?: {
    readonly threadId: string;
    readonly messageIndex: number;
    readonly delta: string;
  };
  readonly assistantMessageComplete?: { readonly threadId: string; readonly message: ChatMessageJson };
  readonly assistantThreadStopped?: { readonly threadId: string };
  readonly assistantRetryRequested?: { readonly threadId: string };
  readonly assistantThreadStatusChanged?: { readonly threadId: string; readonly status: WireAssistantThreadStatus };
  readonly assistantThreadRenamed?: { readonly threadId: string; readonly name: string };
  readonly assistantResent?: { readonly threadId: string; readonly message: ChatMessageJson };
  readonly assistantToolCall?: {
    readonly threadId: string;
    readonly parentId?: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly args?: unknown;
  };
  readonly assistantToolResult?: {
    readonly threadId: string;
    readonly toolCallId: string;
    readonly summary: string;
    readonly isError: boolean;
  };
  readonly proposalDrafted?: { readonly proposal: CardProposalJson };
  readonly proposalConfirmed?: {
    readonly proposalId: string;
    readonly items: ProposalItemJson[];
    readonly outcomes: ProposalOutcomeJson[];
    readonly confirmedAt: string;
  };
  readonly proposalDiscarded?: { readonly proposalId: string };
}

/** The payload field names (the oneof members, camelCase). */
export const EVENT_KINDS = [
  'cardCreated',
  'cardMoved',
  'cardTypeChanged',
  'cardAssigned',
  'cardArchived',
  'subStateUpdated',
  'dependencyStateChanged',
  'automationToggled',
  'planningSessionCreated',
  'userMessageReceived',
  'agentMessageDelta',
  'agentMessageComplete',
  'planDocumentUpdated',
  'planningSessionCompleted',
  'cardsCommitted',
  'projectCreated',
  'projectDirectoryChanged',
  'projectActivated',
  'projectArchived',
  'projectRestored',
  'agentSessionStarted',
  'agentSessionEnded',
  'agentToolCall',
  'agentToolResult',
  'pipelineSaved',
  'pipelineDeleted',
  'pipelineRunStarted',
  'pipelineStepStarted',
  'pipelineStepFinished',
  'pipelineRunEnded',
  'pipelineGateResponded',
  'commandOutput',
  'assistantThreadCreated',
  'assistantThreadArchived',
  'assistantThreadRestored',
  'assistantThreadScopeChanged',
  'assistantUserMessage',
  'assistantMessageDelta',
  'assistantMessageComplete',
  'assistantThreadStopped',
  'assistantRetryRequested',
  'assistantThreadStatusChanged',
  'assistantThreadRenamed',
  'assistantResent',
  'assistantToolCall',
  'assistantToolResult',
  'proposalDrafted',
  'proposalConfirmed',
  'proposalDiscarded',
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

/** Which payload a wire event carries (the oneof case), if any. */
export function domainEventKind(event: DomainEventJson): EventKind | undefined {
  for (const kind of EVENT_KINDS) {
    if (event[kind] !== undefined) return kind;
  }
  return undefined;
}

/** Move a frame's body under its eventType key (SSE frame → oneof event). */
export function frameToDomainEvent(frame: EventFrameJson): DomainEventJson {
  return {
    id: frame.id,
    projectId: frame.projectId,
    occurredAt: frame.occurredAt,
    [frame.eventType]: frame.body,
  } as DomainEventJson;
}

// ---- Commands (client → server) ----

/** The PublishRequest command field names (the oneof members, camelCase). */
export type CommandKind =
  | 'requestProjectCreate'
  | 'requestProjectSetDirectory'
  | 'requestProjectActivate'
  | 'requestProjectArchive'
  | 'requestProjectRestore'
  | 'requestCardMove'
  | 'requestCardTypeChange'
  | 'requestCardArchive'
  | 'requestAutomationToggle'
  | 'requestPlanningSessionCreate'
  | 'requestUserMessage'
  | 'requestPipelineSave'
  | 'requestPipelineDelete'
  | 'requestPipelineRun'
  | 'requestPipelineStop'
  | 'requestPipelineGateRespond'
  | 'requestAssistantThreadCreate'
  | 'requestAssistantThreadArchive'
  | 'requestAssistantThreadRestore'
  | 'requestAssistantThreadScope'
  | 'requestAssistantMessage'
  | 'requestAssistantThreadStop'
  | 'requestAssistantRetry'
  | 'requestAssistantThreadRename'
  | 'requestAssistantResend'
  | 'requestProposalConfirm'
  | 'requestProposalDiscard'
  | 'requestAgentSessionStart'
  | 'requestAgentSessionStop';

/**
 * The service-facing command DTO (oneof-shaped). The transport converts it
 * onto the server's action envelope; the field renames live in that mapping,
 * so services keep their own names (`cardId`, `toLane`, …).
 */
export interface PublishRequestJson {
  readonly projectId?: string;
  readonly requestProjectCreate?: { readonly name: string; readonly directory?: string };
  readonly requestProjectSetDirectory?: { readonly projectId: string; readonly directory: string };
  readonly requestProjectActivate?: { readonly projectId: string };
  readonly requestProjectArchive?: { readonly projectId: string };
  readonly requestProjectRestore?: { readonly projectId: string };
  readonly requestCardCreate?: {
    readonly title: string;
    readonly description?: string;
    readonly type: WireCardType;
    readonly tags?: readonly string[];
  };
  readonly requestCardMove?: {
    readonly cardId: string;
    readonly toLane: WireStage;
    readonly override?: boolean;
    readonly comment?: string;
  };
  readonly requestCardTypeChange?: { readonly cardId: string; readonly toType: WireCardType };
  readonly requestCardAssign?: { readonly cardId: string; readonly assignee?: AssigneeJson };
  readonly requestCardArchive?: { readonly cardId: string };
  readonly requestAutomationToggle?: { readonly lane: WireStage; readonly on: boolean };
  readonly requestPlanningSessionCreate?: { readonly projectId: string };
  readonly requestUserMessage?: { readonly sessionId: string; readonly text: string };
  readonly requestPipelineSave?: { readonly pipeline: PipelineJson };
  readonly requestPipelineDelete?: { readonly pipelineId: string };
  readonly requestPipelineRun?: { readonly pipelineId: string; readonly cardId: string };
  readonly requestPipelineStop?: { readonly cardId: string };
  readonly requestPipelineGateRespond?: {
    readonly cardId: string;
    readonly approved: boolean;
    readonly comment?: string;
  };
  readonly requestAssistantThreadCreate?: { readonly name?: string };
  readonly requestAssistantThreadArchive?: { readonly threadId: string };
  readonly requestAssistantThreadRestore?: { readonly threadId: string };
  readonly requestAssistantThreadScope?: { readonly threadId: string; readonly projectIds: string[] };
  readonly requestAssistantMessage?: { readonly threadId: string; readonly text: string };
  readonly requestAssistantThreadStop?: { readonly threadId: string };
  readonly requestAssistantRetry?: { readonly threadId: string };
  readonly requestAssistantThreadRename?: { readonly threadId: string; readonly name: string };
  readonly requestAssistantResend?: { readonly threadId: string; readonly messageId: string; readonly text: string };
  readonly requestProposalConfirm?: {
    readonly proposalId: string;
    readonly items: ProposalItemJson[];
  };
  readonly requestProposalDiscard?: { readonly proposalId: string };
}

/** The generic write-path envelope (`POST /action`, http.rs). */
export interface ActionEnvelopeJson {
  readonly type: 'create' | 'update' | 'delete' | 'start' | 'stop' | 'retry';
  readonly on:
    | 'project'
    | 'card'
    | 'planningSession'
    | 'chatMessage'
    | 'automation'
    | 'pipeline'
    | 'pipelineGate'
    | 'assistantThread'
    | 'assistantMessage'
    | 'assistantResend'
    | 'proposal';
  readonly projectId: string;
  readonly body: Record<string, unknown>;
}

/** Where a command DTO is sent, and with which body. */
export type ActionRoute = { readonly path: 'action'; readonly body: ActionEnvelopeJson };

/** The 200 response of both write endpoints (typed rejections included). */
export interface PublishResponseJson {
  readonly ok: boolean;
  readonly rejectionCode?: WireRejectionCode | string;
  readonly rejectionMessage?: string;
}

/** Convert a command DTO onto its action route. Null for unknown commands. */
export function actionForCommand(request: PublishRequestJson): ActionRoute | null {
  const projectId = request.projectId ?? '';
  const env = (
    actionType: ActionEnvelopeJson['type'],
    on: ActionEnvelopeJson['on'],
    body: Record<string, unknown>,
  ): ActionRoute => ({ path: 'action', body: { type: actionType, on, projectId, body } });

  if (request.requestProjectCreate) {
    return env('create', 'project', {
      name: request.requestProjectCreate.name,
      directory: request.requestProjectCreate.directory,
    });
  }
  if (request.requestProjectSetDirectory) {
    return env('update', 'project', {
      id: request.requestProjectSetDirectory.projectId,
      directory: request.requestProjectSetDirectory.directory,
    });
  }
  if (request.requestProjectActivate) {
    return env('update', 'project', {
      id: request.requestProjectActivate.projectId,
      active: true,
    });
  }
  if (request.requestProjectArchive) {
    return env('delete', 'project', { id: request.requestProjectArchive.projectId });
  }
  if (request.requestProjectRestore) {
    return env('update', 'project', {
      id: request.requestProjectRestore.projectId,
      archived: false,
    });
  }
  if (request.requestCardCreate) {
    const create = request.requestCardCreate;
    return env('create', 'card', {
      title: create.title,
      ...(create.description ? { description: create.description } : {}),
      type: create.type,
      ...(create.tags?.length ? { tags: [...create.tags] } : {}),
    });
  }
  if (request.requestCardMove) {
    const body: Record<string, unknown> = {
      id: request.requestCardMove.cardId,
      stage: request.requestCardMove.toLane,
    };
    if (request.requestCardMove.override) body['override'] = true;
    if (request.requestCardMove.comment) body['comment'] = request.requestCardMove.comment;
    return env('update', 'card', body);
  }
  if (request.requestCardTypeChange) {
    return env('update', 'card', {
      id: request.requestCardTypeChange.cardId,
      type: request.requestCardTypeChange.toType,
    });
  }
  if (request.requestCardAssign) {
    // An assignee object assigns; explicit null unassigns (the server keys
    // the mutation on the field's presence).
    return env('update', 'card', {
      id: request.requestCardAssign.cardId,
      assignee: request.requestCardAssign.assignee ?? null,
    });
  }
  if (request.requestCardArchive) {
    return env('delete', 'card', { id: request.requestCardArchive.cardId });
  }
  if (request.requestAutomationToggle) {
    return env('update', 'automation', {
      lane: request.requestAutomationToggle.lane,
      on: request.requestAutomationToggle.on,
    });
  }
  if (request.requestPlanningSessionCreate) {
    return env('create', 'planningSession', {});
  }
  if (request.requestUserMessage) {
    return env('create', 'chatMessage', {
      sessionId: request.requestUserMessage.sessionId,
      text: request.requestUserMessage.text,
    });
  }
  if (request.requestPipelineSave) {
    const pipeline = request.requestPipelineSave.pipeline;
    return env('create', 'pipeline', {
      id: pipeline.id,
      name: pipeline.name,
      steps: pipeline.steps,
    });
  }
  if (request.requestPipelineDelete) {
    return env('delete', 'pipeline', { id: request.requestPipelineDelete.pipelineId });
  }
  if (request.requestPipelineRun) {
    return env('start', 'pipeline', {
      pipelineId: request.requestPipelineRun.pipelineId,
      cardId: request.requestPipelineRun.cardId,
    });
  }
  if (request.requestPipelineStop) {
    return env('stop', 'pipeline', { cardId: request.requestPipelineStop.cardId });
  }
  if (request.requestPipelineGateRespond) {
    const body: Record<string, unknown> = {
      cardId: request.requestPipelineGateRespond.cardId,
      approved: request.requestPipelineGateRespond.approved,
    };
    if (request.requestPipelineGateRespond.comment) {
      body['comment'] = request.requestPipelineGateRespond.comment;
    }
    return env('update', 'pipelineGate', body);
  }
  // Global assistant commands publish without a project scope (projectId '').
  if (request.requestAssistantThreadCreate) {
    const body: Record<string, unknown> = {};
    if (request.requestAssistantThreadCreate.name) {
      body['name'] = request.requestAssistantThreadCreate.name;
    }
    return env('create', 'assistantThread', body);
  }
  if (request.requestAssistantThreadArchive) {
    return env('delete', 'assistantThread', { id: request.requestAssistantThreadArchive.threadId });
  }
  if (request.requestAssistantThreadRestore) {
    return env('update', 'assistantThread', {
      id: request.requestAssistantThreadRestore.threadId,
      archived: false,
    });
  }
  if (request.requestAssistantThreadScope) {
    return env('update', 'assistantThread', {
      id: request.requestAssistantThreadScope.threadId,
      projectIds: [...request.requestAssistantThreadScope.projectIds],
    });
  }
  if (request.requestAssistantMessage) {
    return env('create', 'assistantMessage', {
      threadId: request.requestAssistantMessage.threadId,
      text: request.requestAssistantMessage.text,
    });
  }
  if (request.requestAssistantThreadStop) {
    return env('stop', 'assistantThread', { id: request.requestAssistantThreadStop.threadId });
  }
  if (request.requestAssistantRetry) {
    return env('retry', 'assistantThread', { id: request.requestAssistantRetry.threadId });
  }
  if (request.requestAssistantThreadRename) {
    return env('update', 'assistantThread', {
      id: request.requestAssistantThreadRename.threadId,
      name: request.requestAssistantThreadRename.name,
    });
  }
  if (request.requestAssistantResend) {
    return env('create', 'assistantResend', {
      threadId: request.requestAssistantResend.threadId,
      messageId: request.requestAssistantResend.messageId,
      text: request.requestAssistantResend.text,
    });
  }
  if (request.requestProposalConfirm) {
    return env('update', 'proposal', {
      id: request.requestProposalConfirm.proposalId,
      items: [...request.requestProposalConfirm.items],
    });
  }
  if (request.requestProposalDiscard) {
    return env('delete', 'proposal', { id: request.requestProposalDiscard.proposalId });
  }
  return null;
}

// ---- Enum mapping (wire strings ↔ domain strings) ----

// Stage, card type, and sub-state status wire strings are the same as the
// domain strings; the mappings validate and fall back to the server's parse
// defaults (new / coding / pending).

const STAGE_VALUES: ReadonlySet<string> = new Set(Object.values(WireStage));
const TYPE_VALUES: ReadonlySet<string> = new Set(Object.values(WireCardType));
const SUBSTATE_VALUES: ReadonlySet<string> = new Set(Object.values(WireSubStateStatus));

export function stageFromWire(value: string | undefined): Stage {
  return value !== undefined && STAGE_VALUES.has(value) ? (value as Stage) : 'new';
}

export function stageToWire(stage: Stage): WireStage {
  return stage as WireStage;
}

export function cardTypeFromWire(value: string | undefined): CardType {
  return value !== undefined && TYPE_VALUES.has(value) ? (value as CardType) : 'coding';
}

export function cardTypeToWire(type: CardType): WireCardType {
  return type as WireCardType;
}

export function subStateStatusFromWire(value: string | undefined): SubStateStatus {
  return value !== undefined && SUBSTATE_VALUES.has(value)
    ? (value as SubStateStatus)
    : 'pending';
}

// Planning session status differs: the domain uses uppercase, the wire lowercase.

export function planningSessionStatusFromWire(
  value: string | undefined,
): PlanningSessionStatus {
  return value === WirePlanningSessionStatus.PLANNING_SESSION_STATUS_DONE
    ? 'DONE'
    : 'DRAFTING';
}

// ---- Entity mapping ----

export function cardFromWire(json: CardJson): Card {
  const type = cardTypeFromWire(json.type);
  const stage = stageFromWire(json.stage);
  return new Card({
    id: json.id ?? '',
    type,
    title: json.title ?? '',
    description: json.description ?? '',
    tags: [...(json.tags ?? [])],
    stage: Lane.isValidFor(type, stage) ? stage : 'new',
    blockedBy: [...(json.blockedBy ?? [])],
    assignee: assigneeFromWire(json.assignee),
    sessionId: json.sessionId || undefined,
    branch: json.branch || undefined,
    fileStats: json.fileStats
      ? {
          added: json.fileStats.added ?? 0,
          removed: json.fileStats.removed ?? 0,
          files: json.fileStats.files ?? 0,
        }
      : undefined,
    subState: subStateFromWire(json.subState),
    retries: { ...(json.retries ?? {}) },
    rejectionComment: json.rejectionComment || undefined,
    createdAt: json.createdAt ?? '',
    updatedAt: json.updatedAt ?? '',
  });
}

export function assigneeFromWire(json: AssigneeJson | undefined): Assignee | undefined {
  if (!json?.role) return undefined;
  if (json.role === 'human') return Assignee.human();
  return Assignee.for(
    json.role as Parameters<typeof Assignee.for>[0],
    json.model ?? '',
    json.effort ?? '',
  );
}

function subStateFromWire(json: CardJson['subState']): SubState {
  const out: Partial<Record<SubStateStage, SubStateStatus>> = {};
  for (const [stage, status] of Object.entries(json ?? {})) {
    out[stage as SubStateStage] = subStateStatusFromWire(status);
  }
  return out;
}
