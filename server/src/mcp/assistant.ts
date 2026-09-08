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
import { ASSISTANT_MCP_TOOLS } from '../tools/assistant/index.js';
import {
  serveStdio,
  toolContent,
  type JsonRpcMessage,
  type JsonRpcResponse,
  type McpToolDefinition,
} from './stdio.js';

const TOOLS: McpToolDefinition[] = ASSISTANT_MCP_TOOLS;


/** Handles one JSON-RPC message; every tools/call reaches the server's read route. */
export async function handleMessage(
  message: JsonRpcMessage,
  caller: AssistantReadCaller,
  context: { threadId: string },
): Promise<JsonRpcResponse> {
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
    const args =
      typeof params?.['arguments'] === 'object' && params?.['arguments'] !== null
        ? (params['arguments'] as Record<string, unknown>)
        : {};
    const result = await caller.read(context.threadId, name, args);
    return { jsonrpc: '2.0', id: id ?? null, result: toolContent(result) };
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
      try {
        const response = await fetch(`${serverUrl}/mcp/read`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ threadId, tool, args }),
        });
        if (!response.ok) {
          return { ok: false, error: `composer returned ${response.status}` };
        }
        return (await response.json()) as unknown;
      } catch (error) {
        return { ok: false, error: `composer unreachable: ${String(error)}` };
      }
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
