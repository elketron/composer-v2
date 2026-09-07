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
import {
  serveStdio,
  toolContent,
  type JsonRpcMessage,
  type JsonRpcResponse,
  type McpToolDefinition,
} from './mcp-stdio.js';

const TOOLS: McpToolDefinition[] = [
  {
    name: 'report_outcome',
    description:
      'Reports your stage outcome for the current pipeline step — required when your task message lists stage outcomes. Pass exactly one of the listed outcome names; the pipeline applies the transition (proceed to the next step, or return the card to an earlier stage). Add a note when the card must go back: what the next attempt still needs.',
    inputSchema: {
      type: 'object',
      properties: {
        outcome: { type: 'string', description: "One of the stage's named outcomes, e.g. 'approved'" },
        note: { type: 'string', description: 'Optional verdict note — what a returned card still needs' },
      },
      required: ['outcome'],
    },
  },
  {
    name: 'workflow_start_recording',
    description:
      'Opens a workflow recording for this session: the repeatable procedure you are performing, to be saved into the project (.composer/workflows/) when you stop. Search existing workflows first and follow one when it applies; record a new one only when the procedure is reusable. Give the procedure a short title, a description of when it applies, and tags for later search.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short procedure title, e.g. "Add an HTTP endpoint"' },
        description: { type: 'string', description: 'When this procedure applies (one line)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Keywords for later search' },
      },
      required: ['title'],
    },
  },
  {
    name: 'workflow_add_step',
    description:
      'Appends one step to the open workflow recording — a step you actually performed. Title stays short ("Run the test suite"); detail carries the nuance (which files, which flags, what to watch for); command carries the exact shell command when there is one. Record steps in the order a future agent should do them.',
    inputSchema: {
      type: 'object',
      properties: {
        step: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short step title' },
            detail: { type: 'string', description: 'How to do it: files, flags, caveats' },
            command: { type: 'string', description: 'The exact shell command, when there is one' },
          },
          required: ['title'],
        },
      },
      required: ['step'],
    },
  },
  {
    name: 'workflow_stop_recording',
    description:
      'Finalizes the open recording: writes the workflow file and returns its path. Pass links to what the procedure draws on — project docs paths (docs/…), knowledge note names, card ids. The recording must have at least one step.',
    inputSchema: {
      type: 'object',
      properties: {
        links: {
          type: 'array',
          items: { type: 'string' },
          description: 'Referenced artifacts: docs paths, knowledge note names, card ids',
        },
      },
    },
  },
  {
    name: 'workflow_search',
    description:
      'Searches this project\'s recorded workflows — procedures earlier agents captured (titles, tags, steps). Search at the start of a task and follow a matching workflow instead of rediscovering the procedure.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Whitespace-split keywords, AND-matched' } },
      required: ['query'],
    },
  },
  {
    name: 'workflow_read',
    description:
      'Reads one recorded workflow in full — its frontmatter and its ordered steps. Follow its steps, adapting to the task at hand.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'The workflow file name, e.g. add-an-http-endpoint.md' } },
      required: ['path'],
    },
  },
];

/** Handles one JSON-RPC message; every tools/call reaches the server's worker route. */
export async function handleMessage(
  message: JsonRpcMessage,
  caller: WorkerCaller,
  context: { projectId: string; sessionId: string },
): Promise<JsonRpcResponse | null> {
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
    const result = await caller.call(context.projectId, context.sessionId, name, args);
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
      try {
        const response = await fetch(`${serverUrl}/mcp/worker`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId, sessionId, tool, args }),
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
