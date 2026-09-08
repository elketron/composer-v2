// Composer's worker MCP server (S34) — a stdio child spawned by opencode
// for a pipeline agent step's turn (the coder, tester, reviewer, security
// agents). It exposes the workflow-recording tools and the workflow
// retrieval tools: a worker captures the procedure it just performed into
// the project's `.composer/workflows/` and later retrieves and follows one
// instead of rediscovering it. Every call POSTs to composer's
// `/mcp/worker` route, which re-validates the project and session at call
// time — the child carries no authority of its own.
//
// Context rides the environment (composer → opencode → this process):
// COMPOSER_SERVER_URL, COMPOSER_PROJECT_ID, COMPOSER_SESSION_ID. The wire
// is newline-delimited JSON-RPC; opencode prefixes tool names with the
// server name, so the model sees `composer_workflow_start_recording` etc.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WORKER_TOOL_DEFINITIONS } from '../agents/worker/index.js';
import { postJson } from './http-caller.js';
import { toolContent, type JsonRpcMessage, type JsonRpcResponse, type McpToolDefinition } from './protocol.js';
import { handleMcpMessage } from './server.js';
import { serveStdio } from './stdio.js';

const TOOLS: McpToolDefinition[] = WORKER_TOOL_DEFINITIONS;

/** Handles one JSON-RPC message; every tools/call reaches the server's worker route. */
export async function handleMessage(
  message: JsonRpcMessage,
  caller: WorkerCaller,
  context: { projectId: string; sessionId: string },
): Promise<JsonRpcResponse | null> {
  return handleMcpMessage(message, TOOLS, async (name, args) =>
    toolContent(await caller.call(context.projectId, context.sessionId, name, args)),
  );
}

/** How a tool call reaches composer's validated worker path. */
export interface WorkerCaller {
  call(
    projectId: string,
    sessionId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
}

/**
 * The production caller: POSTs to composer's `/mcp/worker` route. Transport
 * failures surface as tool errors — a dead server must not crash the child.
 */
export function httpWorkerCaller(serverUrl: string): WorkerCaller {
  return {
    async call(projectId, sessionId, tool, args) {
      return postJson<unknown, unknown>(
        `${serverUrl}/mcp/worker`,
        { projectId, sessionId, tool, args },
        'composer',
        (message) => ({ ok: false, error: message }),
      );
    },
  };
}

/** The child-process entry point. */
export function main(env: NodeJS.ProcessEnv = process.env): void {
  const caller = httpWorkerCaller(env['COMPOSER_SERVER_URL'] ?? '');
  const context = {
    projectId: env['COMPOSER_PROJECT_ID'] ?? '',
    sessionId: env['COMPOSER_SESSION_ID'] ?? '',
  };
  serveStdio((message) => handleMessage(message as JsonRpcMessage, caller, context));
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (isMain) {
  main();
}
