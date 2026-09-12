// The MCP route definitions' shared shape: the composer tool surfaces are
// declared once (per agent) and rendered into Pi's custom tools by the
// engine's pi-tools module; each tool call lands on a validated /mcp/*
// HTTP route.

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}