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
import type { CommandOutcome } from '../wire/commands.js';
import { createTickets, editDocument, PLANNER_MCP_TOOLS, type ComposerCaller } from '../agents/planner/index.js';
import { postJson } from './http-caller.js';
import { toolContent, type JsonRpcMessage, type McpToolDefinition } from './protocol.js';
import { handleMcpMessage } from './server.js';
import { serveStdio } from './stdio.js';

export type { JsonRpcMessage, McpToolDefinition } from './protocol.js';

const TOOLS: McpToolDefinition[] = PLANNER_MCP_TOOLS;

/**
 * Handles one JSON-RPC message; returns the response to send, or null for
 * notifications. The caller supplies how tool calls reach composer.
 */
export async function handleMessage(
  message: JsonRpcMessage,
  caller: ComposerCaller,
  context: { projectId: string; sessionId: string },
): Promise<Record<string, unknown> | null> {
  return handleMcpMessage(message, TOOLS, (name, args) => callTool(name, args, caller, context));
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
  return toolContent(result);
}

/**
 * The production caller: POSTs the validated command to composer's
 * `/mcp/command` route. Transport failures surface as tool rejections —
 * a dead server must not crash the MCP child.
 */
export function httpCaller(serverUrl: string): ComposerCaller {
  return {
    async execute(projectId: string, command): Promise<CommandOutcome> {
      return postJson<CommandOutcome, CommandOutcome>(
        `${serverUrl}/mcp/command`,
        { projectId, command },
        'composer',
        (message) => ({ ok: false, rejection: { code: 'invalidCommand', message } }),
      );
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
