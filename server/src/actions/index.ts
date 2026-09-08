// The action envelope → command translation (v1 actions.rs, mechanical):
// the desktop's `POST /action` speaks `{ type, on, body }` pairs; this is
// the one place that maps them onto the command union, leaning on the
// domain objects' lenient `fromAction` parses for the payload shapes.

import type { Command } from '../wire/commands.js';
import { Card, parseCardType, parseSubStateStatus } from '../domain/card.js';
import { Pipeline } from '../domain/pipeline.js';
import { proposalItemFromAction } from '../domain/proposal.js';
import { readObject, readString, asRecord } from '../wire/read.js';

export function fromAction(action: unknown, scopeProjectId?: string): Command | null {
  if (typeof action !== 'object' || action === null) return null;
  const record = asRecord(action);
  const type = readString(record, 'type');
  const on = readString(record, 'on');
  const body = readObject(record, 'body');
  if (type === undefined || on === undefined || body === undefined) return null;

  const str = (key: string): string | undefined => readString(body, key);
  const bool = (key: string): boolean | undefined => {
    const value = body[key];
    return typeof value === 'boolean' ? value : undefined;
  };

  /**
   * The action parsers, keyed `type:on` — a map, not a switch. Each entry
   * turns the action body into its command; the bodies are the original
   * case blocks, verbatim.
   */
  const parsers: Record<string, () => Command | null> = {
    'create:project': () => {
      return {
        type: 'requestProjectCreate',
        name: str('name') ?? '',
        ...(str('directory') !== undefined ? { directory: str('directory') } : {}),
      };
    },
    'update:project': () => {
{
      const projectId = str('id') ?? '';
      if (str('directory') !== undefined) {
        return { type: 'requestProjectSetDirectory', projectId, directory: str('directory') ?? '' };
      }
      if (bool('active') === true) {
        return { type: 'requestProjectActivate', projectId };
      }
      if (bool('archived') === false) {
        return { type: 'requestProjectRestore', projectId };
      }
      return null;
    }
    },
    'delete:project': () => {
{
      const projectId = str('id') ?? '';
      return { type: 'requestProjectArchive', projectId };
    }
    },
    'create:card': () => {
{
      // A single card object, or { cards: [...] } for bulk.
      const cards = body['cards'];
      if (Array.isArray(cards)) {
        return { type: 'requestCardsCreate', cards: cards.map((card) => Card.fromAction(card, scopeProjectId)) };
      }
      return { type: 'requestCardCreate', card: Card.fromAction(body, scopeProjectId) };
    }
    },
    'update:card': () => {
{
      const id = str('id') ?? scopeProjectId;
      if (id === undefined) return null;
      const hasStage = 'stageId' in body;
      const hasPipeline = 'pipelineId' in body;
      const hasType = 'type' in body;
      const hasStepState = 'stepState' in body;
      const hasAssignee = 'assignee' in body;
      const hasReopen = 'reopened' in body;
      // Exactly one mutation field must be present.
      if (
        Number(hasStage) +
          Number(hasPipeline) +
          Number(hasType) +
          Number(hasStepState) +
          Number(hasAssignee) +
          Number(hasReopen) !==
        1
      )
        return null;
      if (hasReopen) {
        return bool('reopened') === true ? { type: 'requestCardReopen', cardId: id } : null;
      }
      if (hasAssignee) {
        // An object assigns ({role: 'human'} for the desktop's "assign to
        // me"); null/absent-value unassigns.
        const raw = body['assignee'];
        const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
        const role = record ? readString(record, 'role') : undefined;
        const assignee =
          record && role
            ? {
                role,
                ...(readString(record, 'model') ? { model: readString(record, 'model') } : {}),
                ...(readString(record, 'effort') ? { effort: readString(record, 'effort') } : {}),
              }
            : undefined;
        return { type: 'requestCardAssign', cardId: id, ...(assignee ? { assignee } : {}) };
      }
      if (hasPipeline) {
        return { type: 'requestCardPipelineAssign', cardId: id, pipelineId: str('pipelineId') ?? '' };
      }
      if (hasStage) {
        return {
          type: 'requestCardStageMove',
          cardId: id,
          toStageId: str('stageId') ?? '',
          override: bool('override') ?? false,
          ...(str('comment') !== undefined ? { comment: str('comment') } : {}),
        };
      }
      if (hasType) {
        return { type: 'requestCardTypeChange', cardId: id, toType: parseCardType(str('type')) };
      }
      const stepState = readObject(body, 'stepState');
      if (stepState === undefined || !('stepId' in stepState) || !('status' in stepState)) return null;
      return {
        type: 'requestStepStateUpdate',
        cardId: id,
        stepId: typeof stepState['stepId'] === 'string' ? stepState['stepId'] : '',
        status: parseSubStateStatus(
          typeof stepState['status'] === 'string' ? stepState['status'] : '',
        ),
      };
    }
    },
    'delete:card': () => {
      return { type: 'requestCardArchive', cardId: str('id') ?? '' };
    },
    'update:automation': () => {
      return {
        type: 'requestAutomationToggle',
        pipelineId: str('pipelineId') ?? '',
        stageId: str('stageId') ?? '',
        on: bool('on') ?? false,
      };
    },
    'create:planningSession': () => {
      return {
        type: 'requestPlanningSessionCreate',
        projectId: scopeProjectId ?? str('projectId') ?? '',
      };
    },
    'create:chatMessage': () => {
      return {
        type: 'requestUserMessage',
        sessionId: str('sessionId') ?? '',
        text: str('text') ?? '',
      };
    },
    'create:pipeline': () => {
      return { type: 'requestPipelineSave', pipeline: Pipeline.draftFromAction(body, scopeProjectId) };
    },
    'delete:pipeline': () => {
      return { type: 'requestPipelineDelete', pipelineId: str('id') ?? '' };
    },
    'start:pipeline': () => {
      return {
        type: 'requestPipelineRun',
        cardId: str('cardId') ?? '',
      };
    },
    'stop:pipeline': () => {
      return { type: 'requestPipelineStop', cardId: str('cardId') ?? '' };
    },
    'update:pipelineGate': () => {
      return {
        type: 'requestPipelineGateRespond',
        cardId: str('cardId') ?? '',
        approved: bool('approved') ?? false,
        ...(str('comment') !== undefined ? { comment: str('comment') } : {}),
      };
    // Global assistant commands (Phase 6): no project scope.
    },
    'create:assistantThread': () => {
      return {
        type: 'requestAssistantThreadCreate',
        ...(str('name') !== undefined ? { name: str('name') } : {}),
      };
    },
    'delete:assistantThread': () => {
      return { type: 'requestAssistantThreadArchive', threadId: str('id') ?? '' };
    },
    'create:assistantMessage': () => {
      return {
        type: 'requestAssistantMessage',
        threadId: str('threadId') ?? '',
        text: str('text') ?? '',
      };
    },
    'create:assistantResend': () => {
      return {
        type: 'requestAssistantResend',
        threadId: str('threadId') ?? '',
        messageId: str('messageId') ?? '',
        text: str('text') ?? '',
      };
    },
    'update:assistantThread': () => {
{
      const threadId = str('id') ?? '';
      if (bool('archived') === false) {
        return { type: 'requestAssistantThreadRestore', threadId };
      }
      const projectIds = body['projectIds'];
      if (Array.isArray(projectIds)) {
        return {
          type: 'requestAssistantThreadScope',
          threadId,
          projectIds: projectIds.filter((id): id is string => typeof id === 'string'),
        };
      }
      if (str('name') !== undefined) {
        return { type: 'requestAssistantThreadRename', threadId, name: str('name') ?? '' };
      }
      return null;
    }
    },
    'stop:assistantThread': () => {
      return { type: 'requestAssistantThreadStop', threadId: str('id') ?? '' };
    },
    'retry:assistantThread': () => {
      return { type: 'requestAssistantRetry', threadId: str('id') ?? '' };
    },
    'update:proposal': () => {
{
      const items = body['items'];
      if (!Array.isArray(items)) return null;
      return {
        type: 'requestProposalConfirm',
        proposalId: str('id') ?? '',
        items: items.map((item) => proposalItemFromAction(item)),
      };
    }
    },
    'delete:proposal': () => {
      return { type: 'requestProposalDiscard', proposalId: str('id') ?? '' };
    // Docs (Phase 9): save is an upsert by path; content rides the body.
    // Rename is one transaction (never overwrites); delete is a tombstone.
    },
    'create:doc': () => {
      return {
        type: 'requestDocSave',
        path: str('path') ?? '',
        content: str('content') ?? '',
      };
    },
    'update:doc': () => {
      return {
        type: 'requestDocRename',
        path: str('path') ?? '',
        to: str('to') ?? '',
      };
    },
    'delete:doc': () => {
      return { type: 'requestDocDelete', path: str('path') ?? '' };
    // Knowledge (Phase 9): global writes over the data-dir library.
    },
    'create:knowledge': () => {
{
      const path = str('path');
      const title = str('title');
      const tags = body['tags'];
      return {
        type: 'requestKnowledgeSave',
        ...(path !== undefined && path !== '' ? { path } : {}),
        ...(title !== undefined && title !== '' ? { title } : {}),
        ...(Array.isArray(tags)
          ? { tags: tags.filter((tag): tag is string => typeof tag === 'string') }
          : {}),
        content: str('content') ?? '',
      };
    }
    },
    'delete:knowledge': () => {
      return { type: 'requestKnowledgeDelete', path: str('path') ?? '' };
    // Agent workflows (S34): the delete path is the human/REST one; the
    // recording commands are MCP-only (the session binding rides them).
    },
    'delete:workflow': () => {
      return { type: 'requestWorkflowDelete', path: str('path') ?? '' };
    },
  };
  const parser = parsers[`${type}:${on}`];
  return parser !== undefined ? parser() : null;
}

export function readScope(action: unknown): string | undefined {
  if (typeof action !== 'object' || action === null) return undefined;
  const value = asRecord(action)['projectId'];
  return typeof value === 'string' && value !== '' ? value : undefined;
}
