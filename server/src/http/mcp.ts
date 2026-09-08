// The MCP tools' validated routes (D8, S34, Phase 6): the composer MCP
// child issues plan-domain commands, the assistant's read tools answer here
// (scoped and re-validated per call), and the workers' recording/retrieval
// tools dispatch through the worker tool folder. None of these are a second
// generic action surface — each is whitelisted to its agent's tools.
import type { Hono } from 'hono';
import type { Command } from '../wire/commands.js';
import type { HttpDeps } from './deps.js';

import { executeWorkerTool, WORKER_MCP_TOOLS } from '../tools/worker/index.js';
import {
  ASSISTANT_MCP_TOOL_NAMES,
  ASSISTANT_KNOWLEDGE_SAVE_TOOL,
  executeAssistantTool,
  type AssistantToolName,
} from '../tools/assistant/index.js';
import { proposalItemFromAction } from '../domain/proposal.js';

/** The commands the MCP tools may issue: the planner's two, and the
 * workers' workflow-recording commands (S34). */
const MCP_COMMAND_TYPES: ReadonlySet<string> = new Set([
  'requestPlanDocumentUpdate',
  'requestTicketsCreate',
  'requestWorkflowRecordStart',
  'requestWorkflowRecordStep',
  'requestWorkflowRecordStop',
]);

/** The assistant's MCP tool whitelist (reads + the proposal draft). */
const ASSISTANT_MCP_TOOLS: ReadonlySet<string> = new Set(ASSISTANT_MCP_TOOL_NAMES);

export function registerMcpRoutes(app: Hono, deps: HttpDeps): void {
  const { bus, processor, knowledge } = deps;

  // The MCP tools' validated-command route (D8): the composer MCP child
  // process issues plan-domain commands here. Whitelisted to the planning
  // commands — it is not a second generic action surface.
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

  // The assistant's read tools (Phase 6): the MCP child issues reads here;
  // the thread's scope is re-validated per call inside the tool executor.
  app.post('/mcp/read', async (context) => {
    const body = await context.req
      .json<{ threadId?: unknown; tool?: unknown; args?: unknown }>()
      .catch(() => undefined);
    const threadId = typeof body?.threadId === 'string' ? body.threadId : '';
    const tool = typeof body?.tool === 'string' ? body.tool : '';
    const args =
      typeof body?.args === 'object' && body?.args !== null ? (body!.args as Record<string, unknown>) : {};
    if (threadId === '' || !ASSISTANT_MCP_TOOLS.has(tool)) {
      return context.json({ error: 'malformed read', detail: 'unknown read tool' }, 400);
    }
    // The assistant's write tools: a proposal draft lands on the validated
    // processor (never creates cards directly); a knowledge save lands on
    // the knowledge store via the processor (metadata events publish).
    if (tool === 'propose_cards') {
      const rawItems = Array.isArray(args['items']) ? (args['items'] as unknown[]) : [];
      const outcome = await processor.execute(undefined, {
        type: 'requestProposalDraft',
        threadId,
        items: rawItems.map((item) => proposalItemFromAction(item)),
      });
      if (!outcome.ok) {
        return context.json({ ok: false, error: outcome.rejection.message });
      }
      const proposals = bus.state.proposals;
      const proposal = [...proposals.values()].at(-1);
      return context.json({ ok: true, proposalId: proposal?.id, itemCount: proposal?.items.length ?? 0 });
    }
    if (tool === ASSISTANT_KNOWLEDGE_SAVE_TOOL) {
      if (!bus.state.assistantThreads.has(threadId)) {
        return context.json({ ok: false, error: `unknown thread ${threadId}` });
      }
      const outcome = await processor.execute(undefined, {
        type: 'requestKnowledgeSave',
        ...(typeof args['path'] === 'string' && args['path'] !== '' ? { path: args['path'] } : {}),
        ...(typeof args['title'] === 'string' ? { title: args['title'] } : {}),
        ...(Array.isArray(args['tags'])
          ? { tags: args['tags'].filter((tag): tag is string => typeof tag === 'string') }
          : {}),
        content: typeof args['content'] === 'string' ? args['content'] : '',
      });
      if (!outcome.ok) {
        return context.json({ ok: false, error: outcome.rejection.message });
      }
      return context.json({ ok: true, savedPath: outcome.savedPath });
    }
    const result = await executeAssistantTool(
      { state: bus.state, knowledge },
      threadId,
      tool as AssistantToolName,
      args,
    );
    return context.json(result);
  });

  // The worker agents' MCP route (S34): the recording tools land on the
  // validated processor (the session binding rides the command); the
  // retrieval tools read the project's workflow files. Every call
  // re-validates the project and session — the child carries no authority.
  app.post('/mcp/worker', async (context) => {
    const body = await context.req
      .json<{ projectId?: unknown; sessionId?: unknown; tool?: unknown; args?: unknown }>()
      .catch(() => undefined);
    const projectId = typeof body?.projectId === 'string' ? body.projectId : '';
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
    const tool = typeof body?.tool === 'string' ? body.tool : '';
    const args =
      typeof body?.args === 'object' && body?.args !== null ? (body!.args as Record<string, unknown>) : {};
    if (projectId === '' || sessionId === '' || !WORKER_MCP_TOOLS.has(tool)) {
      return context.json({ error: 'malformed worker call', detail: 'unknown worker tool' }, 400);
    }
    const result = await executeWorkerTool(deps, projectId, sessionId, tool, args);
    return context.json(result);
  });

}
