// Composer's assistant MCP server (Phase 6) — a stdio child spawned by
// opencode for the global assistant's turns. Read tools plus the two
// routed writes: composer state (overview, cards, plans), the knowledge
// library (search; save writes only the composer data dir), bounded file
// reads inside the scoped project directories, git status/log/diff, and
// restricted web fetches.
// Every call POSTs to composer's `/mcp/read` route, which re-validates
// thread scope and tool names at call time — the child carries no
// authority of its own.
//
// Context rides the environment (composer → opencode → this process):
// COMPOSER_SERVER_URL and COMPOSER_THREAD_ID. opencode prefixes tool names
// with the server name, so the model sees `composer_composer_overview` etc.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ASSISTANT_MCP_TOOLS } from '../agents/assistant/index.js';
import { postJson } from './http-caller.js';
import { toolContent, type JsonRpcMessage, type JsonRpcResponse, type McpToolDefinition } from './protocol.js';
import { handleMcpMessage } from './server.js';
import { serveStdio } from './stdio.js';

const TOOLS: McpToolDefinition[] = ASSISTANT_MCP_TOOLS;


/** Handles one JSON-RPC message; every tools/call reaches the server's read route. */
export async function handleMessage(
  message: JsonRpcMessage,
  caller: AssistantReadCaller,
  context: { threadId: string },
): Promise<JsonRpcResponse> {
  return handleMcpMessage(message, TOOLS, async (name, args) =>
    toolContent(await caller.read(context.threadId, name, args)),
  );
}

/** How a tool call reaches composer's validated read path. */
export interface AssistantReadCaller {
  read(threadId: string, tool: string, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * The production caller: POSTs to composer's `/mcp/read` route. Transport
 * failures surface as tool errors — a dead server must not crash the child.
 */
export function httpReadCaller(serverUrl: string): AssistantReadCaller {
  return {
    async read(threadId, tool, args) {
      return postJson<unknown, unknown>(
        `${serverUrl}/mcp/read`,
        { threadId, tool, args },
        'composer',
        (message) => ({ ok: false, error: message }),
      );
    },
  };
}

/** The child-process entry point. */
export function main(env: NodeJS.ProcessEnv = process.env): void {
  const caller = httpReadCaller(env['COMPOSER_SERVER_URL'] ?? '');
  const context = { threadId: env['COMPOSER_THREAD_ID'] ?? '' };
  serveStdio((message) => handleMessage(message as JsonRpcMessage, caller, context));
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (isMain) {
  main();
}
