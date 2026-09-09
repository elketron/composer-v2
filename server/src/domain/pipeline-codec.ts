// The pipeline action codec (SRV-008): the lenient parses that turn the
// action envelope's body into a pipeline draft (step fields as found,
// defaults where absent). The `Pipeline` model keeps its topology and
// serialization; the boundary parsing lives here so the model doesn't know
// untyped action payloads.

import { readString, asRecord } from '../wire/read.js';
import type {
  Pipeline as PipelineJson,
  PipelineStep as PipelineStepJson,
} from '../wire/models.js';

/** The revision is server-authoritative; a client's value is ignored. */
function readRevision(record: Record<string, unknown>): number {
  return typeof record['revision'] === 'number' ? record['revision'] : 0;
}

/** A timestamp the client actually set (the sentinel '' → absent). */
function readTimestamp(record: Record<string, unknown>, key: string): string {
  const value = readString(record, key);
  return value !== undefined && Date.parse(value) > 0 ? value : '';
}

/** The step the client meant — lenient, an unknown kind defaults to agent. */
export function pipelineStepFromAction(json: unknown): PipelineStepJson {
  const record = asRecord(json);
  const kindRaw = readString(record, 'kind');
  const kind = kindRaw === 'command' || kindRaw === 'human' ? kindRaw : 'agent';
  const outcomes = Array.isArray(record['outcomes']) ? record['outcomes'] : [];
  return {
    id: readString(record, 'id') ?? '',
    kind,
    boardVisible: record['boardVisible'] !== false,
    ...(record['terminal'] === true ? { terminal: true } : {}),
    ...(readString(record, 'agentKind') !== undefined ? { agentKind: readString(record, 'agentKind') } : {}),
    ...(readString(record, 'instructions') !== undefined
      ? { instructions: readString(record, 'instructions') }
      : {}),
    ...(readString(record, 'command') !== undefined ? { command: readString(record, 'command') } : {}),
    ...(readString(record, 'description') !== undefined
      ? { description: readString(record, 'description') }
      : {}),
    ...(outcomes.length > 0
      ? {
          outcomes: outcomes.map((rule) => {
            const outcome = asRecord(rule);
            const toStepId = readString(outcome, 'toStepId');
            return {
              outcome: readString(outcome, 'outcome') ?? '',
              ...(toStepId !== undefined && toStepId !== '' ? { toStepId } : {}),
            };
          }),
        }
      : {}),
    ...(record['requiresOutcome'] === true ? { requiresOutcome: true } : {}),
    ...(readString(record, 'errorReturnToStepId') !== undefined
      ? { errorReturnToStepId: readString(record, 'errorReturnToStepId')! }
      : {}),
  };
}

/** The pipeline draft the client meant — steps lenient, per-kind fields as found. */
export function pipelineDraftFromAction(json: unknown, scopeProjectId: string | undefined): PipelineJson {
  const record = asRecord(json);
  const steps = Array.isArray(record['steps']) ? record['steps'] : [];
  return {
    id: readString(record, 'id') ?? '',
    projectId: readString(record, 'projectId') ?? scopeProjectId ?? '',
    name: readString(record, 'name') ?? '',
    revision: readRevision(record),
    steps: steps.map((step) => pipelineStepFromAction(step)),
    updatedAt: readTimestamp(record, 'updatedAt'),
  };
}