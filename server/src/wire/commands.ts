// Commands — client-originated requests to change state, validated against
// current state; on success the canonical events are emitted, on failure a
// typed rejection (and nothing else). Ported from v1 with the v2 trims.

import type {
  Assignee,
  Card,
  CardType,
  Pipeline,
  Stage,
  SubStateStatus,
} from './models.js';

export type Command =
  | { type: 'requestProjectCreate'; name: string; directory?: string }
  | { type: 'requestProjectSetDirectory'; projectId: string; directory: string }
  | { type: 'requestProjectActivate'; projectId: string }
  | { type: 'requestProjectArchive'; projectId: string }
  | { type: 'requestProjectRestore'; projectId: string }
  | { type: 'requestCardCreate'; card: Card }
  | { type: 'requestCardsCreate'; cards: Card[] }
  | { type: 'requestCardMove'; cardId: string; toLane: Stage; override: boolean; comment?: string }
  | { type: 'requestCardTypeChange'; cardId: string; toType: CardType }
  | { type: 'requestCardAssign'; cardId: string; assignee?: Assignee }
  | { type: 'requestCardArchive'; cardId: string }
  | { type: 'requestSubStateUpdate'; cardId: string; stage: string; status: SubStateStatus }
  | { type: 'requestAutomationToggle'; lane: Stage; on: boolean }
  | { type: 'requestPlanningSessionCreate'; projectId: string }
  | { type: 'requestUserMessage'; sessionId: string; text: string }
  // No HTTP action: issued by the planner agent's MCP tools.
  | { type: 'requestPlanDocumentUpdate'; sessionId: string; document: string }
  | { type: 'requestTicketsCreate'; sessionId: string; tickets: TicketEmission[] }
  | { type: 'requestPipelineSave'; pipeline: Pipeline }
  | { type: 'requestPipelineDelete'; pipelineId: string }
  | { type: 'requestPipelineRun'; pipelineId: string; cardId: string }
  | { type: 'requestPipelineStop'; cardId: string }
  | { type: 'requestPipelineGateRespond'; cardId: string; approved: boolean; comment?: string }
  // Global assistant commands (Phase 6) — issued without a project scope.
  | { type: 'requestAssistantThreadCreate'; name?: string }
  | { type: 'requestAssistantThreadArchive'; threadId: string }
  | { type: 'requestAssistantThreadRestore'; threadId: string }
  | { type: 'requestAssistantThreadScope'; threadId: string; projectIds: string[] }
  | { type: 'requestAssistantMessage'; threadId: string; text: string };

/** One ticket the planner emits on approval; lands as an ordinary card. */
export interface TicketEmission {
  /** In-batch key for cross-referencing blockedBy entries. */
  key?: string;
  title: string;
  cardType: CardType;
  description: string;
  /** Existing card ids or in-batch ticket keys. */
  blockedBy: string[];
}

export type RejectionCode =
  | 'unknownProject'
  | 'unknownCard'
  | 'unknownSession'
  | 'invalidLane'
  | 'blocked'
  | 'invalidType'
  | 'invalidCommand'
  | 'unknownPipeline'
  | 'unknownAgentKind'
  | 'pipelineAlreadyRunning'
  | 'pipelineNotRunning'
  | 'unknownThread';

export interface Rejection {
  code: RejectionCode;
  message: string;
}

export type CommandOutcome =
  | { ok: true }
  | { ok: false; rejection: Rejection };
