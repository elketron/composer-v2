// The Pi custom tools (gate 4): Composer's validated MCP surfaces become
// in-process Pi custom tools. Every routed tool POSTs the same validated
// route (/mcp/command, /mcp/worker, /mcp/read), so scope and command
// validation stay server-side regardless of model behavior. The planner's
// plan editor is local and takes no path argument — the session's plan
// document is fixed at construction, so no model-provided path can widen
// the write surface.

import { readFile, writeFile } from 'node:fs/promises';

import { ASSISTANT_MCP_TOOLS } from '../agents/assistant/index.js';
import { PLANNER_MCP_TOOLS } from '../agents/planner/index.js';
import { WORKER_TOOL_DEFINITIONS } from '../agents/worker/index.js';
import { postJson } from '../mcp/http-caller.js';
import type { McpToolDefinition } from '../mcp/protocol.js';
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type, type TSchema } from 'typebox';

import type { AgentTurnSpec } from './types.js';

/** The result a Pi tool execute returns. */
type PiToolResult = AgentToolResult<unknown>;

function toolResult(payload: unknown): PiToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    details: undefined,
  };
}

/** A rejected tool call throws — pi turns the throw into the error result. */
function toolError(message: string): never {
  throw new Error(message);
}

/** The rejection message of a routed tool result (CommandOutcome or tool shape). */
function rejectionMessage(payload: Record<string, unknown>): string {
  const rejection = payload['rejection'];
  if (typeof rejection === 'object' && rejection !== null) {
    const message = (rejection as Record<string, unknown>)['message'];
    if (typeof message === 'string') return message;
  }
  if (typeof payload['error'] === 'string') return payload['error'];
  return JSON.stringify(payload);
}

/** POSTs one routed tool call; rejections throw (pi's error-result path). */
async function postTool(
  url: string,
  body: Record<string, unknown>,
): Promise<PiToolResult> {
  const response = await postJson<unknown, string>(url, body, 'composer', (message) => message);
  if (typeof response === 'string') throw new Error(response);
  const payload = response as Record<string, unknown> | null;
  if (payload === null || typeof payload !== 'object' || payload['ok'] === false) {
    throw new Error(rejectionMessage(payload ?? {}));
  }
  return toolResult(payload);
}

/** The MCP definitions become Pi tools that POST their route verbatim. */
function routedTools(
  definitions: readonly McpToolDefinition[],
  url: string,
  body: (tool: string, args: Record<string, unknown>) => Record<string, unknown>,
): ToolDefinition[] {
  return definitions.map((definition) => ({
    name: definition.name,
    label: toolLabel(definition.name),
    description: definition.description,
    parameters: typeboxSchema(definition.inputSchema),
    execute: async (_toolCallId, params): Promise<PiToolResult> =>
      postTool(url, body(definition.name, params as Record<string, unknown>)),
  }));
}

/** The workers' Composer tools (outcome + workflows) over /mcp/worker. */
export function piWorkerTools(spec: AgentTurnSpec): ToolDefinition[] {
  return routedTools(WORKER_TOOL_DEFINITIONS, `${spec.serverUrl}/mcp/worker`, (tool, args) => ({
    projectId: spec.projectId,
    sessionId: spec.sessionId,
    tool,
    args,
  }));
}

/** The assistant's reads and routed writes over /mcp/read. */
export function piAssistantTools(spec: AgentTurnSpec): ToolDefinition[] {
  return routedTools(ASSISTANT_MCP_TOOLS, `${spec.serverUrl}/mcp/read`, (tool, args) => ({
    threadId: spec.sessionId,
    tool,
    args,
  }));
}

/** The plan document read shared by the planner's two tools. */
async function readPlan(planPath: string): Promise<string> {
  try {
    return await readFile(planPath, 'utf8');
  } catch (error) {
    throw new Error(`could not read the plan document: ${String(error)}`);
  }
}

function requirePlanPath(planPath: string | undefined): string {
  if (planPath === undefined) throw new Error('this session has no plan document');
  return planPath;
}

/**
 * The planner's tools: the path-restricted plan editor plus ticket
 * emission over /mcp/command.
 */
export function piPlannerTools(spec: AgentTurnSpec): ToolDefinition[] {
  const planPath = spec.planDocumentPath;
  const editPlan: ToolDefinition = {
    name: 'edit_plan',
    label: 'Edit plan',
    description:
      'Edits the session plan document (plan.md) — the only file you can change. Pass edits for exact text replacement (each edit replaces the first exact occurrence of oldText; keep oldText as small as possible while still unique), or pass document for the complete new plan when the document is empty or a rewrite is cleaner.',
    parameters: Type.Object({
      edits: Type.Optional(
        Type.Array(
          Type.Object({
            oldText: Type.String({ description: 'The exact text to replace' }),
            newText: Type.String({ description: 'The replacement text' }),
          }),
          { description: 'The edits to apply in order' },
        ),
      ),
      document: Type.Optional(
        Type.String({ description: 'The complete plan document — replaces the file wholesale' }),
      ),
    }),
    execute: async (_toolCallId, params): Promise<PiToolResult> => {
      const { edits, document } = params as {
        edits?: Array<{ oldText?: unknown; newText?: unknown }>;
        document?: unknown;
      };
      const path = requirePlanPath(planPath);
      if (edits === undefined && document === undefined) {
        throw new Error('pass edits or the complete document');
      }
      if (document !== undefined) {
        if (typeof document !== 'string' || document.trim() === '') {
          throw new Error('document must be a non-empty string');
        }
        if (Array.isArray(edits)) throw new Error('pass edits or the complete document, not both');
        try {
          await writeFile(path, document);
        } catch (error) {
          throw new Error(`could not write the plan document: ${String(error)}`);
        }
        return toolResult({ ok: true, updated: true });
      }
      if (!Array.isArray(edits) || edits.length === 0) {
        throw new Error('edits must be a non-empty list');
      }
      const original = await readPlan(path);
      let updated = original;
      for (const edit of edits) {
        if (typeof edit?.oldText !== 'string' || typeof edit?.newText !== 'string') {
          throw new Error('each edit needs oldText and newText strings');
        }
        if (edit.oldText === '') throw new Error('oldText must not be empty');
        if (!updated.includes(edit.oldText)) {
          throw new Error(
            `oldText not found in the plan document: ${JSON.stringify(edit.oldText.slice(0, 120))}`,
          );
        }
        updated = updated.replace(edit.oldText, edit.newText);
      }
      if (updated === original) throw new Error('no edit changed the document');
      try {
        await writeFile(path, updated);
      } catch (error) {
        throw new Error(`could not write the plan document: ${String(error)}`);
      }
      return toolResult({ ok: true, updated: true });
    },
  };
  const createTickets: ToolDefinition = {
    name: 'create_tickets',
    label: 'Create tickets',
    description: PLANNER_MCP_TOOLS[0]?.description ?? "Emits the plan document's tickets as cards.",
    parameters: Type.Object({
      pipelineId: Type.String({ description: 'Target pipeline id from the current pipeline inventory' }),
    }),
    execute: async (_toolCallId, params): Promise<PiToolResult> => {
      const pipelineId = (params as { pipelineId?: unknown })['pipelineId'];
      if (typeof pipelineId !== 'string' || pipelineId === '') {
        throw new Error('pipelineId is required');
      }
      const document = await readPlan(requirePlanPath(planPath));
      return postTool(`${spec.serverUrl}/mcp/command`, {
        projectId: spec.projectId,
        command: {
          type: 'requestTicketsCreate',
          sessionId: spec.sessionId,
          pipelineId,
          document,
        },
      });
    },
  };
  return [editPlan, createTickets];
}

/** The per-mode custom tool set (the spec's MCP surface selection). */
export function piCustomTools(spec: AgentTurnSpec): ToolDefinition[] {
  switch (spec.mcpTools) {
    case 'planner':
      return piPlannerTools(spec);
    case 'assistant':
      return piAssistantTools(spec);
    case 'worker':
      return piWorkerTools(spec);
    default:
      return [];
  }
}

function toolLabel(name: string): string {
  return name
    .replace(/^composer_/, '')
    .split('_')
    .map((part) => (part === '' ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}

/** The MCP definitions' JSON schema dialect → its typebox equivalent. */
function typeboxSchema(json: unknown): TSchema {
  const node = json as {
    type?: string;
    description?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    items?: unknown;
    enum?: string[];
  };
  const options = node.description !== undefined ? { description: node.description } : {};
  if (Array.isArray(node.enum)) {
    return Type.Union(
      node.enum.map((value) => Type.Literal(value)),
      options,
    );
  }
  switch (node.type) {
    case 'string':
      return Type.String(options);
    case 'number':
      return Type.Number(options);
    case 'boolean':
      return Type.Boolean(options);
    case 'array':
      return Type.Array(typeboxSchema(node.items), options);
    case 'object': {
      const properties: Record<string, TSchema> = {};
      for (const [name, property] of Object.entries(node.properties ?? {})) {
        const schema = typeboxSchema(property);
        properties[name] = node.required?.includes(name) === true ? schema : Type.Optional(schema);
      }
      return Type.Object(properties, options);
    }
    default:
      return Type.Unknown(options);
  }
}