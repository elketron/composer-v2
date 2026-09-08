// The planner's MCP command route (D8): the composer MCP child process
// issues plan-domain commands here. Whitelisted to the planning commands —
// it is not a second generic action surface.

import type { Hono } from 'hono';
import type { Command } from '../../wire/commands.js';
import type { HttpDeps } from '../deps.js';

/** The commands the planner's MCP tools may issue. */
const MCP_COMMAND_TYPES: ReadonlySet<string> = new Set([
  'requestPlanDocumentUpdate',
  'requestTicketsCreate',
  'requestWorkflowRecordStart',
  'requestWorkflowRecordStep',
  'requestWorkflowRecordStop',
]);

export function registerPlannerMcpRoutes(app: Hono, deps: HttpDeps): void {
  const { processor } = deps;
  app.post('/mcp/command', async (context) => {
    const body = await context.req
      .json<{ projectId?: unknown; command?: unknown }>()
      .catch(() => undefined);
    const projectId = typeof body?.projectId === 'string' ? body.projectId : undefined;
    const command = body?.command as { type?: unknown } | undefined;
    if (
      projectId === undefined ||
      projectId === '' ||
      typeof command !== 'object' ||
      command === null ||
      typeof command.type !== 'string' ||
      !MCP_COMMAND_TYPES.has(command.type)
    ) {
      return context.json({ error: 'malformed command', detail: 'unknown command shape' }, 400);
    }
    const outcome = await processor.execute(projectId, command as Command);
    return context.json(outcome);
  });
}