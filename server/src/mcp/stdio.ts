// The MCP wire both composer MCP servers speak: newline-delimited JSON-RPC
// over stdio (probed against opencode 1.18.25 — see docs/milestones.md S2).
// The framing is shared; each server owns its tool list and handlers.

import { createInterface } from 'node:readline';
import type { JsonRpcMessage, JsonRpcResponse } from './protocol.js';

export { toolContent } from './protocol.js';
export type { JsonRpcMessage, JsonRpcResponse, McpToolDefinition } from './protocol.js';

/**
 * Reads newline-delimited JSON-RPC messages from stdin, hands each to
 * `handle`, and writes non-null responses to stdout. Malformed lines are
 * dropped; a slow tool never blocks the reader.
 */
export function serveStdio(
  handle: (message: JsonRpcMessage) => Promise<JsonRpcResponse>,
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = {
    input: process.stdin,
    output: process.stdout,
  },
): void {
  const send = (message: Record<string, unknown>): void => {
    io.output.write(JSON.stringify(message) + '\n');
  };
  createInterface({ input: io.input }).on('line', (line) => {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    void handle(message).then((response) => {
      if (response !== null) send(response);
    });
  });
}
