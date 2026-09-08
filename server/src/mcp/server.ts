import type { JsonRpcMessage, JsonRpcResponse, McpToolDefinition } from './protocol.js';

/** Dispatches the JSON-RPC methods shared by every Composer MCP server. */
export async function handleMcpMessage(
  message: JsonRpcMessage,
  tools: McpToolDefinition[],
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
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
    return { jsonrpc: '2.0', id: id ?? null, result: { tools } };
  }
  if (method === 'tools/call') {
    const name = typeof params?.['name'] === 'string' ? params['name'] : '';
    const rawArgs = params?.['arguments'];
    const args =
      typeof rawArgs === 'object' && rawArgs !== null ? (rawArgs as Record<string, unknown>) : {};
    return { jsonrpc: '2.0', id: id ?? null, result: await callTool(name, args) };
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
