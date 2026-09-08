import { pipelineDraftFromAction } from '../domain/pipeline-codec.js';
import type { ActionRegistry } from './types.js';

export const pipelineActions: ActionRegistry = {
  'create:pipeline': ({ body, scopeProjectId }) => ({
    type: 'requestPipelineSave',
    pipeline: pipelineDraftFromAction(body, scopeProjectId),
  }),
  'delete:pipeline': ({ str }) => ({ type: 'requestPipelineDelete', pipelineId: str('id') ?? '' }),
  'start:pipeline': ({ str }) => ({ type: 'requestPipelineRun', cardId: str('cardId') ?? '' }),
  'stop:pipeline': ({ str }) => ({ type: 'requestPipelineStop', cardId: str('cardId') ?? '' }),
  'update:pipelineGate': ({ str, bool }) => ({
    type: 'requestPipelineGateRespond',
    cardId: str('cardId') ?? '',
    approved: bool('approved') ?? false,
    ...(str('comment') !== undefined ? { comment: str('comment') } : {}),
  }),
};
