// The MCP server (D8): the JSON-RPC surface and the two planner tools —
// each call must land as the exact validated command the processor takes.

import { describe, expect, it, vi, afterEach } from 'vitest';
import { handleMessage, httpCaller } from '../src/mcp.js';
import type { Command, CommandOutcome } from '../src/wire/commands.js';

const context = { projectId: 'P-1', sessionId: 'S-1' };

function scriptedCaller(outcomes: CommandOutcome[]): {
  caller: import('../src/engine/planner-tools.js').ComposerCaller;
  commands: { projectId: string; command: Command }[];
} {
  const commands: { projectId: string; command: Command }[] = [];
  return {
    commands,
    caller: {
      async execute(projectId, command) {
        commands.push({ projectId, command });
        return outcomes[commands.length - 1] ?? { ok: true };
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the mcp json-rpc surface', () => {
  it('initialize_reports_the_server_capabilities', async () => {
    const { caller } = scriptedCaller([]);
    const response = await handleMessage(
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
      caller,
      context,
    );
    const result = (response!['result'] ?? {}) as { serverInfo?: { name?: string }; capabilities?: unknown };
    expect(result.serverInfo?.name).toBe('composer');
    expect(result.capabilities).toEqual({ tools: {} });
  });

  it('notifications_get_no_response', async () => {
    const { caller } = scriptedCaller([]);
    const response = await handleMessage(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      caller,
      context,
    );
    expect(response).toBeNull();
  });

  it('tools_list_exposes_the_two_planner_tools', async () => {
    const { caller } = scriptedCaller([]);
    const response = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, caller, context);
    const tools = (response!['result'] as { tools: { name: string }[] }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(['edit_document', 'create_tickets']);
  });

  it('edit_document_issues_the_validated_command', async () => {
    const { caller, commands } = scriptedCaller([{ ok: true }]);
    const response = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'edit_document', arguments: { document: '<plan>v1</plan>' } },
      },
      caller,
      context,
    );
    expect(commands).toEqual([
      {
        projectId: 'P-1',
        command: { type: 'requestPlanDocumentUpdate', sessionId: 'S-1', document: '<plan>v1</plan>' },
      },
    ]);
    const result = response!['result'] as { content: { text: string }[]; isError: boolean };
    expect(JSON.parse(result.content[0]!.text)).toEqual({ committed: true });
    expect(result.isError).toBe(false);
  });

  it('create_tickets_normalizes_the_type_alias_and_defaults_the_card_type', async () => {
    const { caller, commands } = scriptedCaller([{ ok: true }]);
    await handleMessage(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'create_tickets',
          arguments: {
            tickets: [
              { title: 'a', type: 'docs', description: 'd' },
              { title: 'b', cardType: 'design' },
            ],
          },
        },
      },
      caller,
      context,
    );
    expect(commands[0]?.command).toEqual({
      type: 'requestTicketsCreate',
      sessionId: 'S-1',
      tickets: [
        { title: 'a', cardType: 'docs', description: 'd', blockedBy: [] },
        { title: 'b', cardType: 'design', description: '', blockedBy: [] },
      ],
    });
  });

  it('rejections_surface_as_tool_results', async () => {
    const { caller } = scriptedCaller([
      { ok: false, rejection: { code: 'invalidCommand', message: 'Session S-1 is done; its plan document is closed' } },
    ]);
    const response = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'edit_document', arguments: { document: 'late edit' } },
      },
      caller,
      context,
    );
    const result = response!['result'] as { content: { text: string }[] };
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      committed: false,
      rejection: 'Session S-1 is done; its plan document is closed',
    });
  });

  it('an_unknown_tool_is_a_tool_result_not_an_error', async () => {
    const { caller, commands } = scriptedCaller([]);
    const response = await handleMessage(
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'conjure', arguments: {} } },
      caller,
      context,
    );
    expect(commands).toHaveLength(0);
    const result = response!['result'] as { content: { text: string }[] };
    expect(JSON.parse(result.content[0]!.text).rejection).toContain('unknown tool');
  });
});

describe('the http caller', () => {
  it('posts_to_the_mcp_route_and_maps_the_outcome', async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, rejection: { code: 'unknownSession', message: 'Unknown session S-1' } }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchStub);
    const caller = httpCaller('http://127.0.0.1:5214');
    const outcome = await caller.execute('P-1', {
      type: 'requestPlanDocumentUpdate',
      sessionId: 'S-1',
      document: 'x',
    });
    expect(outcome).toEqual({
      ok: false,
      rejection: { code: 'unknownSession', message: 'Unknown session S-1' },
    });
    expect(fetchStub).toHaveBeenCalledWith(
      'http://127.0.0.1:5214/mcp/command',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('a_transport_failure_is_a_typed_rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('connection refused')),
    );
    const caller = httpCaller('http://127.0.0.1:1');
    const outcome = await caller.execute('P-1', {
      type: 'requestPlanDocumentUpdate',
      sessionId: 'S-1',
      document: 'x',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejection.message).toContain('composer unreachable');
  });
});
