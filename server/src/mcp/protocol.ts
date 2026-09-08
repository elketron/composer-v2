export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

export type JsonRpcResponse = Record<string, unknown> | null;

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The response envelope every tools/call result rides. */
export function toolContent(result: unknown): {
  content: { type: string; text: string }[];
  isError: boolean;
} {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
}
