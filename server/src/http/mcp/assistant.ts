// The assistant's MCP read route (Phase 6): the MCP child issues reads
// here; the thread's scope is re-validated per call inside the tool
// executor. The two write tools route through the validated processor: a
// proposal draft lands on the processor (never creates cards directly), a
// knowledge save lands on the knowledge store via the processor (metadata
// events publish).

import type { Hono } from 'hono';
import type { HttpDeps } from '../deps.js';
import {
  ASSISTANT_MCP_TOOL_NAMES,
  ASSISTANT_KNOWLEDGE_SAVE_TOOL,
  executeAssistantTool,
  type AssistantToolName,
} from '../../agents/assistant/index.js';
import { proposalItemFromAction } from '../../domain/proposal.js';

/** The assistant's MCP tool whitelist (reads + the proposal draft). */
const ASSISTANT_MCP_TOOLS: ReadonlySet<string> = new Set(ASSISTANT_MCP_TOOL_NAMES);

export function registerAssistantMcpRoutes(app: Hono, deps: HttpDeps): void {
  const { bus, processor, knowledge } = deps;
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
}