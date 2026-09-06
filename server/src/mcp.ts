// Composer's MCP server (D8) — a stdio child process spawned by the agent
// runtime (opencode) per its inline MCP config. It exposes the planner's
// two domain tools and issues the same validated commands the desktop
// would: every tool call POSTs to composer's `/mcp/command` route, which
// runs the processor. Commits stay validated regardless of model behavior.
//
// Session context rides the environment (composer → opencode → this
// process): COMPOSER_SERVER_URL, COMPOSER_PROJECT_ID, COMPOSER_SESSION_ID.
// The wire is newline-delimited JSON-RPC (probed against opencode
// 1.18.25); opencode prefixes tool names with the server name, so the
// planner sees `composer_edit_document` / `composer_create_tickets`.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CommandOutcome } from './wire/commands.js';
import { createTickets, editDocument, type ComposerCaller } from './engine/planner-tools.js';
import { serveStdio, type JsonRpcMessage, type McpToolDefinition } from './mcp-stdio.js';

export type { JsonRpcMessage, McpToolDefinition };

const TOOLS: McpToolDefinition[] = [
  {
    name: 'edit_document',
    description:
      'Replaces the plan document with the complete, updated version. Call this every turn before replying.',
    inputSchema: {
      type: 'object',
      properties: { document: { type: 'string', description: 'The full plan document' } },
      required: ['document'],
    },
  },
  {
    name: 'create_tickets',
    description:
      'Emits the approved plan as tickets (title, cardType coding|design|docs, description, blockedBy of existing card ids or in-batch key strings, optional key). Only call on explicit user approval.',
    inputSchema: {
      type: 'object',
      properties: {
        tickets: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              cardType: { type: 'string', enum: ['coding', 'design', 'docs'] },
              description: { type: 'string' },
              blockedBy: { type: 'array', items: { type: 'string' } },
              key: { type: 'string' },
            },
            required: ['title'],
          },
        },
      },
      required: ['tickets'],
    },
  },
];

/**
 * Handles one JSON-RPC message; returns the response to send, or null for
 * notifications. The caller supplies how tool calls reach composer.
 */
export async function handleMessage(
  message: JsonRpcMessage,
  caller: ComposerCaller,
  context: { projectId: string; sessionId: string },
): Promise<Record<string, unknown> | null> {
  const { id, method, params } = message;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: id ?? null,
      result: {
        protocolVersion:
          typeof params?.['protocolVersion'] === 'string' ? params['protocolVersion'] : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'composer', version: '0.1.0' },
      },
    };
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return null;
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id: id ?? null, result: { tools: TOOLS } };
  }
  if (method === 'tools/call') {
    const name = typeof params?.['name'] === 'string' ? params['name'] : '';
    const rawArgs = params?.['arguments'];
    const args: Record<string, unknown> =
      typeof rawArgs === 'object' && rawArgs !== null ? (rawArgs as Record<string, unknown>) : {};
    const result = await callTool(name, args, caller, context);
    return { jsonrpc: '2.0', id: id ?? null, result };
  }
  if (id !== undefined && id !== null) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `unknown method ${String(method)}` },
    };
  }
  return null;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  caller: ComposerCaller,
  context: { projectId: string; sessionId: string },
): Promise<{ content: { type: string; text: string }[]; isError: boolean }> {
  let result: { committed: boolean; rejection?: string; cards?: number };
  if (name === 'edit_document') {
    const document = typeof args['document'] === 'string' ? args['document'] : null;
    if (document === null) {
      result = { committed: false, rejection: 'the document argument is required' };
    } else {
      const outcome = await editDocument(caller, context.projectId, context.sessionId, document);
      result = outcome.ok ? { committed: true } : { committed: false, rejection: outcome.message };
    }
  } else if (name === 'create_tickets') {
    const outcome = await createTickets(caller, context.projectId, context.sessionId, args['tickets']);
    result = outcome.ok ? { committed: true, cards: outcome.cards } : { committed: false, rejection: outcome.message };
  } else {
    result = { committed: false, rejection: `unknown tool ${name}` };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
}

/**
 * The production caller: POSTs the validated command to composer's
 * `/mcp/command` route. Transport failures surface as tool rejections —
 * a dead server must not crash the MCP child.
 */
export function httpCaller(serverUrl: string): ComposerCaller {
  return {
    async execute(projectId: string, command): Promise<CommandOutcome> {
      try {
        const response = await fetch(`${serverUrl}/mcp/command`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId, command }),
        });
        if (!response.ok) {
          return { ok: false, rejection: { code: 'invalidCommand', message: `composer returned ${response.status}` } };
        }
        return (await response.json()) as CommandOutcome;
      } catch (error) {
        return { ok: false, rejection: { code: 'invalidCommand', message: `composer unreachable: ${String(error)}` } };
      }
    },
  };
}

/** The child-process entry point: stdio JSON-RPC over the HTTP caller. */
export function main(env: NodeJS.ProcessEnv = process.env): void {
  const serverUrl = env['COMPOSER_SERVER_URL'] ?? '';
  const projectId = env['COMPOSER_PROJECT_ID'] ?? '';
  const sessionId = env['COMPOSER_SESSION_ID'] ?? '';
  const caller = httpCaller(serverUrl);
  const context = { projectId, sessionId };
  serveStdio((message) => handleMessage(message, caller, context));
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (isMain) {
  main();
}
