// Commands — client-originated requests to change state, validated against
// current state; on success the canonical events are emitted, on failure a
// typed rejection (and nothing else). Ported from v1 with the v2 trims;
// Phase 10 replaces lane moves with pipeline-local stage moves and gives
// runs first-class identities.

import type {
  Assignee,
  Card,
  CardType,
  Diagram,
  DiagramViewport,
  Pipeline,
  ProposalItem,
  SubStateStatus,
  WorkflowStep,
} from './models.js';
export type Command =
  | { type: 'requestProjectCreate'; name: string; directory?: string }
  | { type: 'requestProjectSetDirectory'; projectId: string; directory: string }
  | { type: 'requestProjectActivate'; projectId: string }
  | { type: 'requestProjectArchive'; projectId: string }
  | { type: 'requestProjectRestore'; projectId: string }
  | { type: 'requestCardCreate'; card: Card }
  | { type: 'requestCardsCreate'; cards: Card[] }
  | { type: 'requestCardLaneMove'; cardId: string; toLaneId: string; override: boolean; comment?: string }
  | { type: 'requestCardPipelineAssign'; cardId: string; pipelineId: string }
  | { type: 'requestCardReopen'; cardId: string }
  | { type: 'requestCardTypeChange'; cardId: string; toType: CardType }
  | { type: 'requestCardAssign'; cardId: string; assignee?: Assignee }
  | { type: 'requestCardArchive'; cardId: string }
  | { type: 'requestStepStateUpdate'; cardId: string; stepId: string; status: SubStateStatus }
  | { type: 'requestAutomationToggle'; pipelineId: string; laneId: string; on: boolean }
  | { type: 'requestPlanningSessionCreate'; projectId: string }
  | { type: 'requestUserMessage'; sessionId: string; text: string }
  // Planner persistence commands; ticket creation carries the native-edit
  // artifact so the processor synchronizes it before committing cards.
  | { type: 'requestPlanDocumentUpdate'; sessionId: string; document: string }
  | { type: 'requestTicketsCreate'; sessionId: string; pipelineId: string; document: string }
  | { type: 'requestPipelineSave'; pipeline: Pipeline }
  | { type: 'requestPipelineDelete'; pipelineId: string }
  // The run resolves the pipeline from the card's assignment (one pipeline
  // per card) and executes from the card's current stage onward.
  | { type: 'requestPipelineRun'; cardId: string }
  | { type: 'requestPipelineStop'; cardId: string }
  | { type: 'requestPipelineGateRespond'; cardId: string; approved: boolean; comment?: string }
  // The outcome tool's command (S36): MCP-only — a worker agent signals
  // its stage outcome; the processor validates it against the run's
  // pinned revision and publishes the decision record.
  | { type: 'requestPipelineOutcomeReport'; sessionId: string; outcome: string; note?: string }
  // Global assistant commands (Phase 6) — issued without a project scope.
  | { type: 'requestAssistantThreadCreate'; name?: string }
  | { type: 'requestAssistantThreadArchive'; threadId: string }
  | { type: 'requestAssistantThreadRestore'; threadId: string }
  | { type: 'requestAssistantThreadScope'; threadId: string; projectIds: string[] }
  | {
      type: 'requestAssistantMessage';
      threadId: string;
      text: string;
      parentId?: string;
      projectIds?: string[];
    }
  // Conversation controls (Phase 7).
  | { type: 'requestAssistantThreadStop'; threadId: string }
  | { type: 'requestAssistantRetry'; threadId: string }
  | { type: 'requestAssistantThreadRename'; threadId: string; name: string }
  | { type: 'requestAssistantResend'; threadId: string; messageId: string; text: string }
  // Work proposals (Phase 8): the draft rides the assistant's MCP tool;
  // confirm/discard come from the desktop's proposal panel.
  | { type: 'requestProposalDraft'; threadId: string; items: ProposalItem[] }
  | { type: 'requestProposalConfirm'; proposalId: string; items: ProposalItem[] }
  | { type: 'requestProposalDiscard'; proposalId: string }
  // Docs (Phase 9): project-scoped writes over `<projectDirectory>/docs/`.
  // The content rides the command; the events carry metadata only.
  // Rename is one transaction (a single rename), landing as docSaved(new)
  // + docDeleted(old); it never overwrites an existing target.
  | { type: 'requestDocSave'; path: string; content: string }
  | { type: 'requestDocRename'; path: string; to: string }
  | { type: 'requestDocDelete'; path: string }
  // Knowledge (Phase 9): global writes over the data dir's library.
  // With a path the content is the exact file (desktop edit); without one
  // title/tags frontmatter the entry and a unique slug filename.
  | {
      type: 'requestKnowledgeSave';
      path?: string;
      title?: string;
      tags?: string[];
      content: string;
    }
  | { type: 'requestKnowledgeDelete'; path: string }
  // Agent workflows (S34): a worker agent records a procedure over its MCP
  // tools — start opens the recording, add_step appends to it, stop
  // finalizes it into `.composer/workflows/` (the write + the metadata
  // event). The recording lives in the processor, keyed by the agent
  // session. Delete is the human/REST path.
  | { type: 'requestWorkflowRecordStart'; sessionId: string; title: string; description?: string; tags?: string[] }
  | { type: 'requestWorkflowRecordStep'; sessionId: string; step: WorkflowStep }
  | { type: 'requestWorkflowRecordStop'; sessionId: string; links?: string[] }
  | { type: 'requestWorkflowDelete'; path: string }
  // Diagrams (Phase 11): the canvas's database-backed saves. Content rides
  // the command; the events carry the full diagram for the fold/snapshot.
  // The viewport save is viewport-only so panning never clashes with a
  // content save (and never trips the client's unsaved-changes guard).
  | { type: 'requestDiagramSave'; diagram: Diagram }
  | { type: 'requestDiagramDelete'; diagramId: string }
  | { type: 'requestDiagramViewport'; diagramId: string; viewport: DiagramViewport };

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
  | 'unknownPipeline'
  | 'unknownStep'
  | 'unknownLane'
  | 'unknownDiagram'
  | 'blocked'
  | 'invalidType'
  | 'invalidCommand'
  | 'runActive'
  | 'pipelineNotRunning'
  | 'unknownAgentKind'
  | 'unknownThread'
  | 'unknownProposal';

export interface Rejection {
  code: RejectionCode;
  message: string;
}

export type CommandOutcome =
  // `savedPath` rides knowledge saves: the agent's tool result names the
  // file the note landed in (slug + uniqueness happen server-side).
  // `runId` rides run starts: the MCP/tool callers can name the attempt.
  // `transition` rides outcome reports: the tool result tells the model
  // what its verdict will do.
  // `cards` rides ticket emission: the agent's tool result names the count.
  // `pipelineId` rides pipeline saves: a fresh draft adopts the allocated
  // id so a second save updates instead of duplicating.
  // `diagramId` rides diagram saves: the canvas adopts the allocated id.
  | { ok: true; savedPath?: string; runId?: string; transition?: string; cards?: number; pipelineId?: string; diagramId?: string }
  | { ok: false; rejection: Rejection };
