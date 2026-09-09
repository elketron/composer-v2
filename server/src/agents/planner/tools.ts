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
 * `create_tickets` — emits the plan's tickets as validated cards and closes
 * the session. The tickets come from the session's markdown plan document
 * (its `# Title` + YAML-frontmatter blocks), not a structured argument —
 * the document is the single source of truth.
 */
export async function createTickets(
  caller: ComposerCaller,
  projectId: string,
  sessionId: string,
  pipelineId: string,
  document: string,
): Promise<{ ok: true; cards: number } | ToolRejection> {
  const outcome = await caller.execute(projectId, {
    type: 'requestTicketsCreate',
    sessionId,
    pipelineId,
    document,
  });
  return outcome.ok ? { ok: true, cards: outcome.cards ?? 0 } : { ok: false, message: outcome.rejection.message };
}

/** The planner's MCP tool definition; plan edits use the native edit tool. */
export const PLANNER_MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'create_tickets',
    description:
      'Synchronizes plan.md and emits its tickets as cards in the selected pipeline. Only call on explicit user approval.',
    inputSchema: {
      type: 'object',
      properties: {
        pipelineId: { type: 'string', description: 'Target pipeline id from the current pipeline inventory' },
      },
      required: ['pipelineId'],
    },
  },
];
