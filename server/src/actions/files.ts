import type { ActionRegistry } from './types.js';

export const fileActions: ActionRegistry = {
  'create:doc': ({ str }) => ({
    type: 'requestDocSave',
    path: str('path') ?? '',
    content: str('content') ?? '',
  }),
  'update:doc': ({ str }) => ({
    type: 'requestDocRename',
    path: str('path') ?? '',
    to: str('to') ?? '',
  }),
  'delete:doc': ({ str }) => ({ type: 'requestDocDelete', path: str('path') ?? '' }),
  'create:knowledge': ({ body, str }) => {
    const path = str('path');
    const title = str('title');
    const tags = body['tags'];
    return {
      type: 'requestKnowledgeSave',
      ...(path ? { path } : {}),
      ...(title ? { title } : {}),
      ...(Array.isArray(tags) ? { tags: tags.filter((tag): tag is string => typeof tag === 'string') } : {}),
      content: str('content') ?? '',
    };
  },
  'delete:knowledge': ({ str }) => ({ type: 'requestKnowledgeDelete', path: str('path') ?? '' }),
  'delete:workflow': ({ str }) => ({ type: 'requestWorkflowDelete', path: str('path') ?? '' }),
};
