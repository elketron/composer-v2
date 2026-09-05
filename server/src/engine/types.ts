// The engine boundary (D2): agent execution delegates to a runtime
// (opencode in production, a scripted fake in tests). The planning
// orchestrator builds a turn spec, streams the runtime's output through
// `onEvent`, and gets one outcome. Everything runtime-specific stays
// behind this interface.

/** One agent turn the orchestrator asks the runtime to run. */
export interface AgentTurnSpec {
  projectId: string;
  /** The composer planning session the turn belongs to. */
  sessionId: string;
  /** The project directory the runtime works in (cwd; agent files live here). */
  projectDirectory?: string;
  /** The turn's message: the user's text plus the in-context document. */
  prompt: string;
  /** The runtime's own session id, for continuity across turns. */
  engineSessionId?: string;
  /** Composer's HTTP base — the MCP tools' callback target. */
  serverUrl: string;
  /** Absolute path to composer's MCP server script (dist/mcp.js). */
  mcpScriptPath: string;
  /** The shipped agent the runtime loads (`--agent <name>`). */
  agentName: string;
  /** Wall-clock cap for the turn (ms). */
  timeoutMs: number;
  /** Aborted when the run is stopped — the runtime's process is killed. */
  signal?: AbortSignal;
}

/** Streamed turn output. Deltas are transient; completes are durable. */
export type AgentTurnEvent =
  | { kind: 'messageDelta'; messageId: string; delta: string }
  | { kind: 'messageComplete'; messageId: string; text: string };

export interface AgentTurnOutcome {
  ok: boolean;
  error?: string;
  /** The runtime's session id — stored for the next turn's continuity. */
  engineSessionId?: string;
}

export interface AgentEngine {
  readonly name: string;
  run(
    spec: AgentTurnSpec,
    onEvent: (event: AgentTurnEvent) => void,
  ): Promise<AgentTurnOutcome>;
}
