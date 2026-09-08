import type { ActionRegistry } from './types.js';

export const projectActions: ActionRegistry = {
  'create:project': ({ str }) => ({
    type: 'requestProjectCreate',
    name: str('name') ?? '',
    ...(str('directory') !== undefined ? { directory: str('directory') } : {}),
  }),
  'update:project': ({ str, bool }) => {
    const projectId = str('id') ?? '';
    if (str('directory') !== undefined) {
      return { type: 'requestProjectSetDirectory', projectId, directory: str('directory') ?? '' };
    }
    if (bool('active') === true) return { type: 'requestProjectActivate', projectId };
    if (bool('archived') === false) return { type: 'requestProjectRestore', projectId };
    return null;
  },
  'delete:project': ({ str }) => ({
    type: 'requestProjectArchive',
    projectId: str('id') ?? '',
  }),
};
