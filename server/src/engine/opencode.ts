// The opencode runtime adapter (D2): spawns `opencode run --agent <name>
// --format json` in the project directory and parses the event stream.
//
// The wire schema (captured 2026-09-05, opencode 1.18.25 — see
// docs/milestones.md S3): stdout is one JSON object per line, but vendor
// banner lines (the llama.cpp plugin's) precede it — non-JSON lines are
// skipped. Events: `{type, timestamp, sessionID, part}` with type
// step_start | text | tool_use | step_finish; `text` parts may arrive
// repeatedly with growing text (streamed), `step_finish` carries reason
// "stop" | "tool-calls".
//
// Continuity: the runtime's session id (the first event's `sessionID`) is
// returned in the outcome; the next turn passes it back via `-s`. The MCP
// registration rides `OPENCODE_CONFIG_CONTENT` per spawn, so nothing in
// the user's project config is touched; session context (project, session,
// callback URL) rides the environment, which the MCP child inherits.

import { spawn } from 'node:child_process';
import type {
  AgentEngine,
  AgentTurnEvent,
  AgentTurnOutcome,
  AgentTurnSpec,
} from './types.js';

export interface OpenCodeEngineOptions {
  /** The opencode binary (default: `opencode` on PATH). */
  binary?: string;
  /** The shipped agent name the turn loads. */
  agentName?: string;
  /** Wall-clock cap per turn (default 10 minutes). */
  defaultTimeoutMs?: number;
}

interface WireEvent {
  type: string;
  sessionID?: string;
  part?: {
    id?: string;
    messageID?: string;
    type?: string;
    text?: string;
    reason?: string;
    tool?: string;
    callID?: string;
    state?: { status?: string; input?: unknown; output?: unknown; metadata?: { truncated?: boolean; error?: string } };
  };
}

interface TextPart {
  text: string;
  emitted: number;
}

export class OpenCodeEngine implements AgentEngine {
  readonly name = 'opencode';
  private readonly binary: string;
  private readonly agentName: string;
  private readonly defaultTimeoutMs: number;

  constructor(options: OpenCodeEngineOptions = {}) {
    this.binary = options.binary ?? 'opencode';
    this.agentName = options.agentName ?? 'composer-planner';
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 600_000;
  }

  async run(
    spec: AgentTurnSpec,
    onEvent: (event: AgentTurnEvent) => void,
  ): Promise<AgentTurnOutcome> {
    const agentName = spec.agentName !== '' ? spec.agentName : this.agentName;
    const args = ['run', '--format', 'json', '--agent', agentName];
    if (spec.engineSessionId !== undefined) {
      args.push('-s', spec.engineSessionId);
    }
    args.push(spec.prompt);

    const child = spawn(this.binary, args, {
      ...(spec.projectDirectory !== undefined ? { cwd: spec.projectDirectory } : {}),
      env: {
        ...process.env,
        COMPOSER_SERVER_URL: spec.serverUrl,
        COMPOSER_PROJECT_ID: spec.projectId,
        COMPOSER_SESSION_ID: spec.sessionId,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(mcpConfig(spec)),
        // opencode trusts $PWD over the real cwd for workspace discovery —
        // a stale inherited PWD points it at the wrong project (probed
        // 2026-09-05). Pin it to the spawn directory.
        ...(spec.projectDirectory !== undefined
          ? { PWD: spec.projectDirectory, OLDPWD: spec.projectDirectory }
          : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return await new Promise<AgentTurnOutcome>((resolve) => {
      let engineSessionId: string | undefined;
      let stderr = '';
      let stdoutTail = '';
      const parts = new Map<string, TextPart>();
      const tools = new Map<string, ToolCallState>();
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
      }, spec.timeoutMs > 0 ? spec.timeoutMs : this.defaultTimeoutMs);
      timeout.unref?.();
      const onAbort = (): void => {
        clearTimeout(timeout);
        child.kill('SIGKILL');
      };
      spec.signal?.addEventListener('abort', onAbort, { once: true });
      const settle = (outcome: AgentTurnOutcome): void => {
        clearTimeout(timeout);
        spec.signal?.removeEventListener('abort', onAbort);
        resolve(outcome);
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdoutTail = (stdoutTail + chunk).slice(-2_000);
        for (const line of chunk.split('\n')) {
          const event = parseLine(line);
          if (event === null) continue;
          if (event.sessionID !== undefined && engineSessionId === undefined) {
            engineSessionId = event.sessionID;
          }
          handleEvent(event, parts, tools, onEvent);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
      });
      child.on('error', (error) => {
        settle({ ok: false, error: `opencode spawn failed: ${String(error)}`, engineSessionId });
      });
      child.on('close', (code) => {
        // Flush any part whose complete was never superseded.
        for (const [id, part] of parts) {
          if (part.text !== '') onEvent({ kind: 'messageComplete', messageId: id, text: part.text });
        }
        if (code === 0) {
          settle({ ok: true, engineSessionId });
          return;
        }
        // Diagnostics first: the run's own error output, else its last
        // unparsed stdout line (opencode reports some crashes there).
        const detail = tail(stderr) !== '' ? tail(stderr) : tail(stdoutTail);
        settle({
          ok: false,
          error:
            detail !== ''
              ? `opencode exited with code ${code}: ${detail}`
              : `opencode exited with code ${code}`,
          engineSessionId,
        });
      });
    });
  }
}

function handleEvent(
  event: WireEvent,
  parts: Map<string, TextPart>,
  tools: Map<string, ToolCallState>,
  onEvent: (event: AgentTurnEvent) => void,
): void {
  if (event.type === 'tool_use') {
    handleToolUse(event, parts, tools, onEvent);
    return;
  }
  if (event.type !== 'text') return;
  const id = event.part?.id ?? event.part?.messageID;
  const text = event.part?.text;
  if (id === undefined || typeof text !== 'string') return;
  let part = parts.get(id);
  if (part === undefined) {
    // A new part closes the previous one (the desktop streams one message
    // at a time; each part is its own transcript entry).
    for (const [previousId, previous] of parts) {
      if (previousId !== id && previous.text !== '') {
        onEvent({ kind: 'messageComplete', messageId: previousId, text: previous.text });
      }
    }
    part = { text: '', emitted: 0 };
    parts.set(id, part);
  }
  if (text.length > part.emitted) {
    onEvent({ kind: 'messageDelta', messageId: id, delta: text.slice(part.emitted) });
    part.emitted = text.length;
  }
  part.text = text;
}

interface ToolCallState {
  announced: boolean;
  settled: boolean;
}

/**
 * tool_use parts arrive repeatedly as the tool runs (pending → running →
 * completed with input/output post-hoc). The call is announced once; the
 * result once, when the state settles.
 */
function handleToolUse(
  event: WireEvent,
  parts: Map<string, TextPart>,
  tools: Map<string, ToolCallState>,
  onEvent: (event: AgentTurnEvent) => void,
): void {
  const part = event.part;
  const callId = part?.callID ?? part?.id;
  if (part === undefined || callId === undefined) return;
  let state = tools.get(callId);
  if (state === undefined) {
    state = { announced: false, settled: false };
    tools.set(callId, state);
  }
  const status = part.state?.status;
  if (!state.announced) {
    state.announced = true;
    onEvent({
      kind: 'toolCall',
      toolCallId: callId,
      toolName: part.tool ?? 'tool',
      ...(part.state?.input !== undefined ? { args: part.state.input } : {}),
    });
    // A first sight already carrying output settles immediately.
    if (part.state?.output !== undefined) {
      state.settled = true;
      onEvent({
        kind: 'toolResult',
        toolCallId: callId,
        content: resultContent(part.state.output, part.state.metadata?.error),
        isError: status === 'error',
      });
    }
    return;
  }
  if (!state.settled && (status === 'completed' || status === 'error')) {
    state.settled = true;
    onEvent({
      kind: 'toolResult',
      toolCallId: callId,
      content: resultContent(part?.state?.output, part?.state?.metadata?.error),
      isError: status === 'error',
    });
  }
}

function resultContent(output: unknown, error: string | undefined): string {
  if (typeof output === 'string') return output;
  if (output === undefined) return error ?? '';
  return JSON.stringify(output);
}

/** One JSON line, or null (banner output and blank lines are skipped). */
function parseLine(line: string): WireEvent | null {
  const trimmed = line.trim();
  if (trimmed === '' || !trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as WireEvent;
    return typeof parsed.type === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function tail(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  const lines = trimmed.split('\n');
  return lines[lines.length - 1] ?? trimmed;
}

/** The composer MCP server, registered inline per spawn (no project config edits). */
function mcpConfig(spec: AgentTurnSpec): Record<string, unknown> {
  return {
    $schema: 'https://opencode.ai/config.json',
    // The settings-configured model override; absent keeps opencode's own
    // default (its config owns the provider endpoint).
    ...(spec.model ? { model: spec.model } : {}),
    mcp: {
      composer: {
        type: 'local',
        command: ['node', spec.mcpScriptPath],
        enabled: true,
      },
    },
  };
}
