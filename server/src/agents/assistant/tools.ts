import type { McpToolDefinition } from '../../mcp/protocol.js';

/** The assistant's MCP tool definitions (reads plus the two routed writes). */
export const ASSISTANT_MCP_TOOLS: McpToolDefinition[] = [
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
