import { Card, parseCardType, parseSubStateStatus } from '../domain/card.js';
import { readObject, readString } from '../wire/read.js';
import type { ActionRegistry } from './types.js';

export const cardActions: ActionRegistry = {
  'create:card': ({ body, scopeProjectId }) => {
    const cards = body['cards'];
    return Array.isArray(cards)
      ? { type: 'requestCardsCreate', cards: cards.map((card) => Card.fromAction(card, scopeProjectId)) }
      : { type: 'requestCardCreate', card: Card.fromAction(body, scopeProjectId) };
  },
  'update:card': ({ body, scopeProjectId, str, bool }) => {
    const id = str('id') ?? scopeProjectId;
    if (id === undefined) return null;
    const fields = ['stageId', 'pipelineId', 'type', 'stepState', 'assignee', 'reopened'];
    if (fields.filter((field) => field in body).length !== 1) return null;

    if ('reopened' in body) {
      return bool('reopened') === true ? { type: 'requestCardReopen', cardId: id } : null;
    }
    if ('assignee' in body) {
      const raw = body['assignee'];
      const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : null;
      const role = record ? readString(record, 'role') : undefined;
      const assignee = record && role ? {
        role,
        ...(readString(record, 'model') ? { model: readString(record, 'model') } : {}),
        ...(readString(record, 'effort') ? { effort: readString(record, 'effort') } : {}),
      } : undefined;
      return { type: 'requestCardAssign', cardId: id, ...(assignee ? { assignee } : {}) };
    }
    if ('pipelineId' in body) {
      return { type: 'requestCardPipelineAssign', cardId: id, pipelineId: str('pipelineId') ?? '' };
    }
    if ('stageId' in body) {
      return {
        type: 'requestCardStageMove',
        cardId: id,
        toStageId: str('stageId') ?? '',
        override: bool('override') ?? false,
        ...(str('comment') !== undefined ? { comment: str('comment') } : {}),
      };
    }
    if ('type' in body) {
      return { type: 'requestCardTypeChange', cardId: id, toType: parseCardType(str('type')) };
    }

    const stepState = readObject(body, 'stepState');
    if (stepState === undefined || !('stepId' in stepState) || !('status' in stepState)) return null;
    return {
      type: 'requestStepStateUpdate',
      cardId: id,
      stepId: typeof stepState['stepId'] === 'string' ? stepState['stepId'] : '',
      status: parseSubStateStatus(typeof stepState['status'] === 'string' ? stepState['status'] : ''),
    };
  },
  'delete:card': ({ str }) => ({ type: 'requestCardArchive', cardId: str('id') ?? '' }),
  'update:automation': ({ str, bool }) => ({
    type: 'requestAutomationToggle',
    pipelineId: str('pipelineId') ?? '',
    stageId: str('stageId') ?? '',
    on: bool('on') ?? false,
  }),
};
