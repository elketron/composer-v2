import { proposalItemFromAction } from '../domain/proposal.js';
import type { ActionRegistry } from './types.js';

export const conversationActions: ActionRegistry = {
  'create:planningSession': ({ scopeProjectId, str }) => ({
    type: 'requestPlanningSessionCreate',
    projectId: scopeProjectId ?? str('projectId') ?? '',
  }),
  'create:chatMessage': ({ str }) => ({
    type: 'requestUserMessage',
    sessionId: str('sessionId') ?? '',
    text: str('text') ?? '',
  }),
  'update:planDocument': ({ str }) => ({
    type: 'requestPlanDocumentUpdate',
    sessionId: str('sessionId') ?? '',
    document: str('document') ?? '',
  }),
  'create:tickets': ({ str }) => ({
    type: 'requestTicketsCreate',
    sessionId: str('sessionId') ?? '',
    pipelineId: str('pipelineId') ?? '',
    document: str('document') ?? '',
  }),
  'create:assistantThread': ({ str }) => ({
    type: 'requestAssistantThreadCreate',
    ...(str('name') !== undefined ? { name: str('name') } : {}),
  }),
  'delete:assistantThread': ({ str }) => ({
    type: 'requestAssistantThreadArchive',
    threadId: str('id') ?? '',
  }),
  'create:assistantMessage': ({ body, str }) => ({
    type: 'requestAssistantMessage',
    threadId: str('threadId') ?? '',
    text: str('text') ?? '',
    ...(str('parentId') !== undefined ? { parentId: str('parentId') } : {}),
    ...(Array.isArray(body['projectIds'])
      ? { projectIds: body['projectIds'].filter((id): id is string => typeof id === 'string') }
      : {}),
  }),
  'create:assistantResend': ({ str }) => ({
    type: 'requestAssistantResend',
    threadId: str('threadId') ?? '',
    messageId: str('messageId') ?? '',
    text: str('text') ?? '',
  }),
  'update:assistantThread': ({ body, str, bool }) => {
    const threadId = str('id') ?? '';
    if (bool('archived') === false) return { type: 'requestAssistantThreadRestore', threadId };
    const projectIds = body['projectIds'];
    if (Array.isArray(projectIds)) {
      return {
        type: 'requestAssistantThreadScope',
        threadId,
        projectIds: projectIds.filter((id): id is string => typeof id === 'string'),
      };
    }
    return str('name') !== undefined
      ? { type: 'requestAssistantThreadRename', threadId, name: str('name') ?? '' }
      : null;
  },
  'stop:assistantThread': ({ str }) => ({ type: 'requestAssistantThreadStop', threadId: str('id') ?? '' }),
  'retry:assistantThread': ({ str }) => ({ type: 'requestAssistantRetry', threadId: str('id') ?? '' }),
  'update:proposal': ({ body, str }) => Array.isArray(body['items']) ? {
    type: 'requestProposalConfirm',
    proposalId: str('id') ?? '',
    items: body['items'].map((item) => proposalItemFromAction(item)),
  } : null,
  'delete:proposal': ({ str }) => ({ type: 'requestProposalDiscard', proposalId: str('id') ?? '' }),
};
