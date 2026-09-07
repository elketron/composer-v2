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
import {
  serveStdio,
  toolContent,
  type JsonRpcMessage,
  type JsonRpcResponse,
  type McpToolDefinition,
} from './mcp-stdio.js';

const TOOLS: McpToolDefinition[] = [
  {
    name: 'composer_overview',
    description:
      'Composer state for the thread\'s projects: cards by stage, active pipeline runs, latest run outcomes, planning sessions. Omit projectId for a portfolio summary across the whole scope.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: 'One scoped project id; omit for the portfolio' } },
    },
  },
  {
    name: 'composer_card',
    description: 'One card in full: description, stage, sub-state, blockers, assignee, latest pipeline run, agent sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        cardId: { type: 'string', description: 'e.g. T-1' },
      },
      required: ['projectId', 'cardId'],
    },
  },
  {
    name: 'composer_plan',
    description: "A project's plan document: the latest planning session's document and its status.",
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        sessionId: { type: 'string', description: 'A specific session; omit for the latest' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'knowledge_search',
    description:
      'Searches the composer knowledge library — saved notes of durable facts, decisions, and conventions (titles, tags, bodies). Search before saving to avoid duplicates, and to recall what earlier sessions recorded.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Whitespace-split keywords, AND-matched' } },
      required: ['query'],
    },
  },
  {
    name: 'list_files',
    description: "Lists one directory of the project (names, kinds, sizes; no recursion, 500 entries max).",
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        path: { type: 'string', description: 'Relative to the project root; "." lists the root' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'read_file',
    description:
      'Reads one text file inside the project (64 KiB cap, binary files detected). Paths cannot escape the project directory.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['projectId', 'path'],
    },
  },
  {
    name: 'git_status',
    description: "The project repository's branch, clean/dirty state, and latest commit.",
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    },
  },
  {
    name: 'git_log',
    description: 'Recent commits (hash, subject, date; 20 max).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        limit: { type: 'number', description: '1-20, default 10' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'git_diff',
    description: 'The working-tree diff (no color, 16 KiB cap), optionally for one path.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'web_fetch',
    description:
      'Fetches an https document (text/json, 256 KiB cap, public hosts only, 3 redirects max) — external documentation.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  {
    name: 'propose_cards',
    description:
      'Drafts board-ready card proposals for the user to review and confirm — it NEVER creates cards. Items: projectId (in scope), title, description, cardType (coding|design|docs), optional in-batch key, blockedBy (existing card ids of the target project or in-batch keys). Only propose when the user asks for work items or approves a plan.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              projectId: { type: 'string' },
              title: { type: 'string' },
              description: { type: 'string' },
              cardType: { type: 'string', enum: ['coding', 'design', 'docs'] },
              key: { type: 'string' },
              blockedBy: { type: 'array', items: { type: 'string' } },
            },
            required: ['projectId', 'title'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'knowledge_save',
    description:
      'Saves a note into the composer knowledge library (markdown, global, survives restarts) and returns its path. Only when the user asks to remember or clearly states a durable fact/decision/convention — never for transient state or project files.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short note title; the filename derives from it' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Keywords for later search' },
        content: { type: 'string', description: 'The note body (markdown)' },
      },
      required: ['title', 'content'],
    },
  },
];


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
