// The planner's domain tools (D8): the exact tool handlers the MCP server
// exposes, parameterized by how they reach composer. In the MCP child
// process they POST to `/mcp/command`; the FakeEngine's scripts call them
// in-process with the processor — either way the commands land on the one
// validated write path, so commits stay validated regardless of model
// behavior.

import type { Command, CommandOutcome, TicketEmission } from '../../wire/commands.js';
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
 * `create_tickets` — emits the planner's tickets as validated cards and
 * closes the session. Defaults a missing card type to `coding` (v1's
 * normalize_ticket); only the schema's `cardType` field is accepted.
 */
export async function createTickets(
  caller: ComposerCaller,
  projectId: string,
  sessionId: string,
  proposed: unknown,
): Promise<{ ok: true; cards: number } | ToolRejection> {
  const tickets = normalizeTickets(proposed);
  if (tickets === null) {
    return { ok: false, message: 'tickets must be an array of ticket objects' };
  }
  const outcome = await caller.execute(projectId, {
    type: 'requestTicketsCreate',
    sessionId,
    tickets,
  });
  return outcome.ok ? { ok: true, cards: tickets.length } : { ok: false, message: outcome.rejection.message };
}

function normalizeTickets(proposed: unknown): TicketEmission[] | null {
  if (!Array.isArray(proposed)) return null;
  const tickets: TicketEmission[] = [];
  for (const entry of proposed) {
    if (typeof entry !== 'object' || entry === null) return null;
    const record = entry as Record<string, unknown>;
    const title = record['title'];
    if (typeof title !== 'string') return null;
    const rawType = record['cardType'] ?? 'coding';
    if (rawType !== 'coding' && rawType !== 'design' && rawType !== 'docs') return null;
    tickets.push({
      ...(typeof record['key'] === 'string' ? { key: record['key'] } : {}),
      title,
      cardType: rawType,
      description: typeof record['description'] === 'string' ? record['description'] : '',
      blockedBy: Array.isArray(record['blockedBy'])
        ? record['blockedBy'].filter((dep): dep is string => typeof dep === 'string')
        : [],
    });
  }
  return tickets;
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
