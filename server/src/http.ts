// The HTTP surface (v1 architecture.md): one generic write endpoint, one
// event stream, and health. Domain rejections are NOT transport errors:
// `200 { ok: false, rejectionCode, rejectionMessage }`; 400 is reserved
// for malformed requests.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { Bus } from './bus.js';
import type { Processor } from './processor.js';
import type { Command } from './wire/commands.js';
import type { Card, CardType, Pipeline, PipelineStep, Stage, SubStateStatus } from './wire/models.js';
import { ALL_STAGES } from './wire/models.js';
import { snapshotEvents } from './snapshot.js';
import type { ComposerSettings, EventStore, SettingsPatch } from './store.js';
import { dashboardProjects } from './dashboard.js';
import {
  ASSISTANT_TOOL_NAMES,
  executeAssistantTool,
  type AssistantToolName,
} from './assistant-tools.js';

/** The commands the MCP tools may issue (the planner's two, for now). */
const MCP_COMMAND_TYPES: ReadonlySet<string> = new Set([
  'requestPlanDocumentUpdate',
  'requestTicketsCreate',
]);

/** The assistant's read-tool whitelist (the MCP child's only surface). */
const ASSISTANT_READ_TOOLS: ReadonlySet<string> = new Set<string>(ASSISTANT_TOOL_NAMES);

export function router(bus: Bus, processor: Processor, store?: EventStore): Hono {
  const app = new Hono();

  // Permissive CORS (the v1 rule): the desktop renderer connects directly,
  // including cross-origin when the server runs in WSL and the desktop on
  // Windows.
  app.use('*', cors());

  app.get('/health', (context) => context.json({ status: 'SERVING' }));

  app.get('/dashboard', async (context) =>
    context.json({ projects: await dashboardProjects(bus.state) }),
  );

  // Global settings (config, not domain history): the desktop's settings
  // view reads and writes these; the runner/planner read them per spawn.
  app.get('/settings', async (context) => {
    const settings = store ? await store.getSettings() : {};
    return context.json(settings);
  });
  app.put('/settings', async (context) => {
    if (store === undefined) {
      return context.json({ error: 'settings unavailable' }, 503);
    }
    const body = (await context.req.json<unknown>().catch(() => undefined)) as Record<
      string,
      unknown
    > | undefined;
    if (typeof body !== 'object' || body === null) {
      return context.json({ error: 'malformed settings' }, 400);
    }
    const patch: SettingsPatch = {};
    if ('model' in body) {
      const model = body['model'];
      if (model !== null && typeof model !== 'string') {
        return context.json({ error: 'malformed settings', detail: 'model must be a string' }, 400);
      }
      // A string sets (trimmed); null or '' clears the override.
      const trimmed = typeof model === 'string' ? model.trim() : '';
      patch.model = trimmed === '' ? null : trimmed;
    }
    if ('models' in body) {
      const raw = body['models'];
      if (raw !== null && typeof raw !== 'object') {
        return context.json({ error: 'malformed settings', detail: 'models must be an object' }, 400);
      }
      if (raw === null) {
        patch.models = {};
      } else {
        const models: Record<string, string | null> = {};
        for (const [kind, value] of Object.entries(raw as Record<string, unknown>)) {
          if (value !== null && typeof value !== 'string') {
            return context.json(
              { error: 'malformed settings', detail: `models.${kind} must be a string` },
              400,
            );
          }
          models[kind] = typeof value === 'string' ? value.trim() : null;
        }
        patch.models = models;
      }
    }
    const saved = await store.putSettings(patch);
    return context.json(saved);
  });

  // The MCP tools' validated-command route (D8): the composer MCP child
  // process issues plan-domain commands here. Whitelisted to the planning
  // commands — it is not a second generic action surface.
  app.post('/mcp/command', async (context) => {
    const body = await context.req
      .json<{ projectId?: unknown; command?: unknown }>()
      .catch(() => undefined);
    const projectId = typeof body?.projectId === 'string' ? body.projectId : undefined;
    const command = body?.command as { type?: unknown } | undefined;
    if (
      projectId === undefined ||
      projectId === '' ||
      typeof command !== 'object' ||
      command === null ||
      typeof command.type !== 'string' ||
      !MCP_COMMAND_TYPES.has(command.type)
    ) {
      return context.json({ error: 'malformed command', detail: 'unknown command shape' }, 400);
    }
    const outcome = await processor.execute(projectId, command as Command);
    return context.json(outcome);
  });

  // The assistant's read tools (Phase 6): the MCP child issues reads here;
  // the thread's scope is re-validated per call inside the tool executor.
  app.post('/mcp/read', async (context) => {
    const body = await context.req
      .json<{ threadId?: unknown; tool?: unknown; args?: unknown }>()
      .catch(() => undefined);
    const threadId = typeof body?.threadId === 'string' ? body.threadId : '';
    const tool = typeof body?.tool === 'string' ? body.tool : '';
    const args =
      typeof body?.args === 'object' && body?.args !== null ? (body!.args as Record<string, unknown>) : {};
    if (threadId === '' || !ASSISTANT_READ_TOOLS.has(tool)) {
      return context.json({ error: 'malformed read', detail: 'unknown read tool' }, 400);
    }
    const result = await executeAssistantTool(
      { state: bus.state },
      threadId,
      tool as AssistantToolName,
      args,
    );
    return context.json(result);
  });

  app.post('/action', async (context) => {
    const action = await context.req.json<unknown>().catch(() => undefined);
    const scope = readScope(action);
    const command = fromAction(action, scope);
    if (command === null) {
      return context.json({ error: 'malformed action', detail: 'unknown action shape' }, 400);
    }
    const outcome = await processor.execute(scope, command);
    if (outcome.ok) {
      return context.json({ ok: true });
    }
    return context.json({
      ok: false,
      rejectionCode: outcome.rejection.code,
      rejectionMessage: outcome.rejection.message,
    });
  });

  app.get('/events', (context) => {
    const projectId = context.req.query('projectId');
    return streamSSE(context, async (stream) => {
      // Subscribe BEFORE the snapshot: live events may queue while the
      // snapshot is written; folds are idempotent, so duplicates reconcile
      // (the v1 rule). All writes serialize through one chain.
      let closed = false;
      let write = Promise.resolve();
      const enqueue = (data: string): void => {
        write = write
          .then(() => (closed ? undefined : stream.writeSSE({ data })))
          .catch(() => {
            closed = true;
          });
      };
      const unsubscribe = bus.subscribe((frame) => {
        if (projectId === undefined || frame.projectId === undefined || frame.projectId === projectId) {
          enqueue(JSON.stringify(frame));
        }
      });
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
      });

      for (const frame of snapshotEvents(bus.state, projectId)) {
        enqueue(JSON.stringify(frame));
      }
      await write;

      // The stream lives until the client disconnects.
      while (!closed) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 250);
          timer.unref?.();
        });
      }
    });
  });

  return app;
}

/** The action envelope → command mapping (v1 actions.rs, mechanical). */
export function fromAction(action: unknown, scopeProjectId?: string): Command | null {
  if (typeof action !== 'object' || action === null) return null;
  const record = action as Record<string, unknown>;
  const type = readString(record, 'type');
  const on = readString(record, 'on');
  const body = readObject(record, 'body');
  if (type === undefined || on === undefined || body === undefined) return null;

  const str = (key: string): string | undefined => readString(body, key);
  const bool = (key: string): boolean | undefined => {
    const value = body[key];
    return typeof value === 'boolean' ? value : undefined;
  };

  switch (`${type}:${on}`) {
    case 'create:project':
      return {
        type: 'requestProjectCreate',
        name: str('name') ?? '',
        ...(str('directory') !== undefined ? { directory: str('directory') } : {}),
      };
    case 'update:project': {
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
    case 'delete:project': {
      const projectId = str('id') ?? '';
      return { type: 'requestProjectArchive', projectId };
    }
    case 'create:card': {
      // A single card object, or { cards: [...] } for bulk.
      const cards = body['cards'];
      if (Array.isArray(cards)) {
        return { type: 'requestCardsCreate', cards: cards.map((card) => readCard(card, scopeProjectId)) };
      }
      return { type: 'requestCardCreate', card: readCard(body, scopeProjectId) };
    }
    case 'update:card': {
      const id = str('id') ?? scopeProjectId;
      if (id === undefined) return null;
      const hasStage = 'stage' in body;
      const hasType = 'type' in body;
      const hasSubState = 'subState' in body;
      const hasAssignee = 'assignee' in body;
      // Exactly one mutation field must be present.
      if (Number(hasStage) + Number(hasType) + Number(hasSubState) + Number(hasAssignee) !== 1)
        return null;
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
      if (hasStage) {
        return {
          type: 'requestCardMove',
          cardId: id,
          toLane: parseStage(str('stage')),
          override: bool('override') ?? false,
          ...(str('comment') !== undefined ? { comment: str('comment') } : {}),
        };
      }
      if (hasType) {
        return { type: 'requestCardTypeChange', cardId: id, toType: parseCardType(str('type')) };
      }
      const subState = readObject(body, 'subState');
      if (subState === undefined || !('stage' in subState) || !('status' in subState)) return null;
      return {
        type: 'requestSubStateUpdate',
        cardId: id,
        stage: typeof subState['stage'] === 'string' ? subState['stage'] : '',
        status: parseSubStateStatus(
          typeof subState['status'] === 'string' ? subState['status'] : '',
        ),
      };
    }
    case 'delete:card':
      return { type: 'requestCardArchive', cardId: str('id') ?? '' };
    case 'update:automation':
      return { type: 'requestAutomationToggle', lane: parseStage(str('lane')), on: bool('on') ?? false };
    case 'create:planningSession':
      return {
        type: 'requestPlanningSessionCreate',
        projectId: scopeProjectId ?? str('projectId') ?? '',
      };
    case 'create:chatMessage':
      return {
        type: 'requestUserMessage',
        sessionId: str('sessionId') ?? '',
        text: str('text') ?? '',
      };
    case 'create:pipeline':
      return { type: 'requestPipelineSave', pipeline: readPipeline(body, scopeProjectId) };
    case 'delete:pipeline':
      return { type: 'requestPipelineDelete', pipelineId: str('id') ?? '' };
    case 'start:pipeline':
      return {
        type: 'requestPipelineRun',
        pipelineId: str('pipelineId') ?? '',
        cardId: str('cardId') ?? '',
      };
    case 'stop:pipeline':
      return { type: 'requestPipelineStop', cardId: str('cardId') ?? '' };
    case 'update:pipelineGate':
      return {
        type: 'requestPipelineGateRespond',
        cardId: str('cardId') ?? '',
        approved: bool('approved') ?? false,
        ...(str('comment') !== undefined ? { comment: str('comment') } : {}),
      };
    // Global assistant commands (Phase 6): no project scope.
    case 'create:assistantThread':
      return {
        type: 'requestAssistantThreadCreate',
        ...(str('name') !== undefined ? { name: str('name') } : {}),
      };
    case 'delete:assistantThread':
      return { type: 'requestAssistantThreadArchive', threadId: str('id') ?? '' };
    case 'create:assistantMessage':
      return {
        type: 'requestAssistantMessage',
        threadId: str('threadId') ?? '',
        text: str('text') ?? '',
      };
    case 'create:assistantResend':
      return {
        type: 'requestAssistantResend',
        threadId: str('threadId') ?? '',
        messageId: str('messageId') ?? '',
        text: str('text') ?? '',
      };
    case 'update:assistantThread': {
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
    case 'stop:assistantThread':
      return { type: 'requestAssistantThreadStop', threadId: str('id') ?? '' };
    case 'retry:assistantThread':
      return { type: 'requestAssistantRetry', threadId: str('id') ?? '' };
    default:
      return null;
  }
}

/** Wire-enum parsing: unknown strings fall back to the first variant (v1 rule). */
function parseStage(value: string | undefined): Stage {
  return ALL_STAGES.includes(value as Stage) ? (value as Stage) : 'new';
}

function parseCardType(value: string | undefined): CardType {
  return value === 'design' || value === 'docs' ? value : 'coding';
}

function parseSubStateStatus(value: string | undefined): SubStateStatus {
  return value === 'running' || value === 'ok' || value === 'failed' ? value : 'pending';
}

/** The card the client meant — every field lenient, defaults where absent. */
function readCard(json: unknown, scopeProjectId: string | undefined): Card {
  const card = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
  const str = (key: string): string | undefined => readString(card, key);
  const assigneeJson = readObject(card, 'assignee');
  const assigneeRole = readString(assigneeJson ?? {}, 'role') ?? 'human';
  const fileStats = readObject(card, 'fileStats');
  const createdAt = str('createdAt');
  const updatedAt = str('updatedAt');
  const created = createdAt !== undefined && Date.parse(createdAt) > 0 ? createdAt : '';
  const updated = updatedAt !== undefined && Date.parse(updatedAt) > 0 ? updatedAt : '';
  return {
    id: str('id') ?? '',
    projectId: str('projectId') ?? scopeProjectId ?? '',
    type: parseCardType(str('type') ?? 'coding'),
    title: str('title') ?? '',
    description: str('description') ?? '',
    tags: readStringArray(card, 'tags'),
    stage: parseStage(str('stage') ?? 'new'),
    blockedBy: readStringArray(card, 'blockedBy'),
    ...(assigneeJson !== undefined
      ? {
          assignee:
            assigneeRole === 'human'
              ? { role: 'human' }
              : {
                  role: assigneeRole,
                  ...(readString(assigneeJson, 'model') ? { model: readString(assigneeJson, 'model') } : {}),
                  ...(readString(assigneeJson, 'effort') ? { effort: readString(assigneeJson, 'effort') } : {}),
                },
        }
      : {}),
    ...(str('sessionId') !== undefined ? { sessionId: str('sessionId') } : {}),
    ...(str('branch') !== undefined ? { branch: str('branch') } : {}),
    ...(fileStats !== undefined
      ? {
          fileStats: {
            added: readNumber(fileStats, 'added'),
            removed: readNumber(fileStats, 'removed'),
            files: readNumber(fileStats, 'files'),
          },
        }
      : {}),
    subState: readSubState(card),
    retries: readRetries(card),
    ...(str('rejectionComment') !== undefined ? { rejectionComment: str('rejectionComment') } : {}),
    createdAt: created,
    updatedAt: updated,
  };
}

function readSubState(card: Record<string, unknown>): Record<string, SubStateStatus> {
  const json = readObject(card, 'subState');
  if (json === undefined) return {};
  const result: Record<string, SubStateStatus> = {};
  for (const [key, value] of Object.entries(json)) {
    result[key] = parseSubStateStatus(typeof value === 'string' ? value : 'pending');
  }
  return result;
}

function readRetries(card: Record<string, unknown>): Record<string, number> {
  const json = readObject(card, 'retries');
  if (json === undefined) return {};
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(json)) {
    if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
  }
  return result;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

/** The pipeline the client meant — steps lenient, per-kind fields as found. */
function readPipeline(json: unknown, scopeProjectId: string | undefined): Pipeline {
  const record = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
  const steps = Array.isArray(record['steps']) ? record['steps'] : [];
  const updatedAt = readString(record, 'updatedAt');
  return {
    id: readString(record, 'id') ?? '',
    projectId: readString(record, 'projectId') ?? scopeProjectId ?? '',
    name: readString(record, 'name') ?? '',
    steps: steps.map((step) => readPipelineStep(step)),
    updatedAt: updatedAt !== undefined && Date.parse(updatedAt) > 0 ? updatedAt : '',
  };
}

function readPipelineStep(json: unknown): PipelineStep {
  const record = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
  const str = (key: string): string | undefined => readString(record, key);
  const kind = str('kind');
  const retries = record['retries'];
  return {
    id: str('id') ?? '',
    kind: kind === 'command' || kind === 'human' ? kind : 'agent',
    ...(str('agentKind') !== undefined ? { agentKind: str('agentKind') } : {}),
    ...(str('instructions') !== undefined ? { instructions: str('instructions') } : {}),
    ...(str('command') !== undefined ? { command: str('command') } : {}),
    ...(str('description') !== undefined ? { description: str('description') } : {}),
    ...(typeof retries === 'number' && Number.isFinite(retries) ? { retries } : {}),
  };
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readScope(action: unknown): string | undefined {
  if (typeof action !== 'object' || action === null) return undefined;
  const value = (action as Record<string, unknown>)['projectId'];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readObject(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}
