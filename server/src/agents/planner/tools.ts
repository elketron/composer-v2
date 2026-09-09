// The planner's domain tools (D8): the exact tool handlers the MCP server
// exposes, parameterized by how they reach composer. In the MCP child
// process they POST to `/mcp/command`; the FakeEngine's scripts call them
// in-process with the processor — either way the commands land on the one
// validated write path, so commits stay validated regardless of model
// behavior.

import type { Command, CommandOutcome } from '../../wire/commands.js';
import type { McpToolDefinition } from '../../mcp/protocol.js';

/** How a tool handler reaches composer's validated command path. */
export interface ComposerCaller {
  execute(projectId: string, command: Command): Promise<CommandOutcome>;
}

export interface ToolRejection {
  ok: false;
  message: string;
}

/**
 * `edit_document` — replaces the session's plan document wholesale.
 * Rejections (unknown/closed session) come back as tool results, not
 * transport errors.
 */
export async function editDocument(
  caller: ComposerCaller,
  projectId: string,
  sessionId: string,
  document: string,
): Promise<{ ok: true } | ToolRejection> {
  const outcome = await caller.execute(projectId, {
    type: 'requestPlanDocumentUpdate',
    sessionId,
    document,
  });
  return outcome.ok ? { ok: true } : { ok: false, message: outcome.rejection.message };
}

/**
 * `create_tickets` — emits the plan's tickets as validated cards and closes
 * the session. The tickets come from the session's markdown plan document
 * (its `# Title` + YAML-frontmatter blocks), not a structured argument —
 * the document is the single source of truth.
 */
export async function createTickets(
  caller: ComposerCaller,
  projectId: string,
  sessionId: string,
): Promise<{ ok: true; cards: number } | ToolRejection> {
  const outcome = await caller.execute(projectId, {
    type: 'requestTicketsCreate',
    sessionId,
  });
  return outcome.ok ? { ok: true, cards: outcome.cards ?? 0 } : { ok: false, message: outcome.rejection.message };
}

/** The planner's MCP tool definitions (the agent brief's two calls, D8). */
export const PLANNER_MCP_TOOLS: McpToolDefinition[] = [
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
      'Emits the plan document\'s tickets as cards (each `# Title` + YAML frontmatter block becomes a card). Only call on explicit user approval.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];
