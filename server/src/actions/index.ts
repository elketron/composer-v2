import type { Command } from '../wire/commands.js';
import { asRecord, readObject, readString } from '../wire/read.js';
import { cardActions } from './cards.js';
import { conversationActions } from './conversations.js';
import { diagramActions } from './diagrams.js';
import { fileActions } from './files.js';
import { pipelineActions } from './pipelines.js';
import { projectActions } from './projects.js';
import { actionContext, type ActionRegistry } from './types.js';

const actions: ActionRegistry = {
  ...projectActions,
  ...cardActions,
  ...pipelineActions,
  ...conversationActions,
  ...fileActions,
  ...diagramActions,
};

export function fromAction(action: unknown, scopeProjectId?: string): Command | null {
  if (typeof action !== 'object' || action === null) return null;
  const record = asRecord(action);
  const type = readString(record, 'type');
  const on = readString(record, 'on');
  const body = readObject(record, 'body');
  if (type === undefined || on === undefined || body === undefined) return null;
  return actions[`${type}:${on}`]?.(actionContext(body, scopeProjectId)) ?? null;
}

export function readScope(action: unknown): string | undefined {
  if (typeof action !== 'object' || action === null) return undefined;
  const value = asRecord(action)['projectId'];
  return typeof value === 'string' && value !== '' ? value : undefined;
}
