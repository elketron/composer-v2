// The streaming opencode runtime (S22): a long-lived `opencode serve`
// process per chat (the assistant's thread) whose `/event` SSE feed carries
// token-level `message.part.delta` events — the `run` command buffers a
// turn's text and emits it once, which reads as no streaming at all.
//
// Lifecycle: one serve per chat key, spawned on the first turn with the
// turn spec's workspace and inline MCP config (the composer MCP child
// inherits the serve's env — COMPOSER_THREAD_ID is per chat, which is why
// this engine is per chat and not global). Continuity: the runtime's
// session id rides `engineSessionId` like the run engine's. Stop: the
// abort signal POSTs `/session/:id/abort` and waits for the turn to wind
// down (`session.error` MessageAbortedError + `session.idle`).
//
// The wire facts were probed against opencode 1.18.25 (docs/milestones.md
// S22): `GET /event` yields `message.updated` (role map),
// `message.part.updated` (part snapshots: text so far, tool state),
// `message.part.delta` (token chunks), `session.error` (MessageAbortedError
// on a stop), and `session.idle` (the turn's end).

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mcpConfig } from './opencode.js';
import type {
  AgentEngine,
  AgentTurnEvent,
  AgentTurnOutcome,
  AgentTurnSpec,
} from './types.js';

export interface OpenCodeServeEngineOptions {
  /** The opencode binary (default: `opencode` on PATH). */
  binary?: string;
  /** Wall-clock cap per turn (default 10 minutes). */
  defaultTimeoutMs?: number;
  /** Health-wait budget per serve spawn. */
  spawnWaitMs?: number;
}

interface ServeEvent {
  type: string;
  properties?: {
    sessionID?: string;
    partID?: string;
    part?: ServePart;
    info?: { id?: string; role?: string };
    status?: { type?: string };
    error?: { name?: string; data?: { message?: string } };
    delta?: string;
    field?: string;
  };
}

interface ServePart {
  id?: string;
  type?: string;
  text?: string;
  tool?: string;
  messageID?: string;
  state?: { status?: string; input?: unknown; output?: unknown; metadata?: { error?: string } };
}

interface PartState {
  text: string;
  completed: boolean;
  toolAnnounced: boolean;
  toolSettled: boolean;
}

/**
 * The turn-driven translation of serve events into turn events (unit
 *-tested): text parts stream as deltas and settle once, tool parts
 * announce then settle, `session.error` records the failure,
 * `session.idle` ends the turn.
 */
export class ServeEventReducer {
  private readonly roles = new Map<string, string>();
  private readonly parts = new Map<string, PartState>();
  private idle = false;
  private error: { name: string; message: string } | null = null;

  apply(event: ServeEvent, sessionId: string, emit: (event: AgentTurnEvent) => void): void {
    const properties = event.properties ?? {};
    if (properties.sessionID !== undefined && properties.sessionID !== sessionId) return;
    switch (event.type) {
      case 'message.updated': {
        const id = properties.info?.id;
        const role = properties.info?.role;
        if (id !== undefined && role !== undefined) this.roles.set(id, role);
        return;
      }
      case 'message.part.updated': {
        const part = properties.part;
        if (part?.id === undefined || part.messageID === undefined) return;
        // The user's own prompt rides the stream as a text part — only the
        // assistant's reply may surface.
        if (this.roles.get(part.messageID) !== 'assistant') return;
        if (part.type === 'text') {
          const state = this.partOf(part.id);
          const incoming = part.text ?? '';
          if (incoming.length > state.text.length) {
            emit({ kind: 'messageDelta', messageId: part.id, delta: incoming.slice(state.text.length) });
            state.text = incoming;
          }
          return;
        }
        if (part.type === 'tool') {
          const state = this.partOf(part.id);
          if (!state.toolAnnounced) {
            state.toolAnnounced = true;
            emit({
              kind: 'toolCall',
              toolCallId: part.id,
              toolName: part.tool ?? 'tool',
              ...(part.state?.input !== undefined ? { args: part.state.input } : {}),
            });
          }
          if (!state.toolSettled && (part.state?.status === 'completed' || part.state?.status === 'error')) {
            state.toolSettled = true;
            emit({
              kind: 'toolResult',
              toolCallId: part.id,
              content: resultContent(part.state?.output, part.state?.metadata?.error),
              isError: part.state?.status === 'error',
            });
          }
        }
        return;
      }
      case 'message.part.delta': {
        const partID = properties.partID;
        if (partID === undefined || properties.field !== 'text' || properties.delta === undefined) return;
        const part = this.parts.get(partID);
        if (part === undefined || part.completed) return;
        part.text += properties.delta;
        emit({ kind: 'messageDelta', messageId: partID, delta: properties.delta });
        return;
      }
      case 'session.error': {
        const name = properties.error?.name ?? 'unknown error';
        this.error = { name, message: properties.error?.data?.message ?? name };
        return;
      }
      case 'session.idle': {
        this.idle = true;
        return;
      }
    }
  }

  private partOf(id: string): PartState {
    let part = this.parts.get(id);
    if (part === undefined) {
      part = { text: '', completed: false, toolAnnounced: false, toolSettled: false };
      this.parts.set(id, part);
    }
    return part;
  }

  /** Completes every open text part (the turn is over). */
  settle(emit: (event: AgentTurnEvent) => void): void {
    for (const [partID, part] of this.parts) {
      if (part.text !== '' && !part.completed) {
        part.completed = true;
        emit({ kind: 'messageComplete', messageId: partID, text: part.text });
      }
    }
  }

  isIdle(): boolean {
    return this.idle;
  }

  failure(): string | undefined {
    return this.error === null ? undefined : this.error.message;
  }

  isAbort(): boolean {
    return this.error?.name === 'MessageAbortedError';
  }
}

function resultContent(output: unknown, error: string | undefined): string {
  if (typeof output === 'string') return output;
  if (output === undefined) return error ?? '';
  return JSON.stringify(output);
}

/** One serve process (per chat key) with its SSE reader and turn listeners. */
interface ServeHandle {
  readonly base: string;
  readonly child: ChildProcess;
  alive: boolean;
  connected: boolean;
  readonly connectedPromise: Promise<void>;
  readonly listeners: Set<(event: ServeEvent) => void>;
}

export class OpenCodeServeEngine implements AgentEngine {
  readonly name = 'opencode-serve';
  private readonly binary: string;
  private readonly defaultTimeoutMs: number;
  private readonly spawnWaitMs: number;
  private readonly serves = new Map<string, ServeHandle>();

  constructor(options: OpenCodeServeEngineOptions = {}) {
    this.binary = options.binary ?? 'opencode';
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 600_000;
    this.spawnWaitMs = options.spawnWaitMs ?? 15_000;
  }

  async run(
    spec: AgentTurnSpec,
    onEvent: (event: AgentTurnEvent) => void,
  ): Promise<AgentTurnOutcome> {
    let serve: ServeHandle;
    try {
      serve = await this.ensureServe(spec);
    } catch (error) {
      return { ok: false, error: `opencode serve failed: ${error instanceof Error ? error.message : String(error)}` };
    }

    const reducer = new ServeEventReducer();
    let sessionId: string | undefined;
    // Events before the prompt belong to no turn of ours; after the
    // session is known, only its stream is relevant (opencode session ids,
    // not composer's).
    const listener = (event: ServeEvent): void => {
      if (sessionId === undefined) return;
      reducer.apply(event, sessionId, onEvent);
    };
    serve.listeners.add(listener);

    const timeout = setTimeout(() => {
      void this.abort(serve, spec).catch(() => undefined);
    }, spec.timeoutMs > 0 ? spec.timeoutMs : this.defaultTimeoutMs);
    timeout.unref?.();
    const onAbort = (): void => {
      clearTimeout(timeout);
      void this.abort(serve, spec).catch(() => undefined);
    };
    if (spec.signal?.aborted) onAbort();
    else spec.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      sessionId = await this.ensureSession(serve, spec);
      const prompt = await fetch(`${serve.base}/session/${sessionId}/prompt_async`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          parts: [{ type: 'text', text: spec.prompt }],
          agent: spec.agentName,
          ...(spec.model !== undefined && spec.model.includes('/') ? { model: toModel(spec.model) } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (prompt.status === 404) {
        // A stale runtime session (the serve restarted) — recreate once.
        this.sessions.delete(spec.sessionId);
        return this.run({ ...spec, engineSessionId: undefined }, onEvent);
      }
      if (!prompt.ok && prompt.status !== 204) {
        return { ok: false, error: `opencode prompt failed with ${prompt.status}`, engineSessionId: sessionId };
      }

      // The turn runs until the session goes idle, errors, or the serve dies.
      for (;;) {
        if (reducer.isIdle()) {
          reducer.settle(onEvent);
          return { ok: true, engineSessionId: sessionId };
        }
        const failure = reducer.failure();
        if (failure !== undefined) {
          reducer.settle(onEvent);
          return {
            ok: false,
            error: reducer.isAbort() ? 'aborted' : `opencode turn failed: ${failure}`,
            engineSessionId: sessionId,
          };
        }
        if (!serve.alive) {
          return { ok: false, error: 'the opencode server exited mid-turn', engineSessionId: sessionId };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } catch (error) {
      return {
        ok: false,
        error: `opencode turn failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      clearTimeout(timeout);
      spec.signal?.removeEventListener('abort', onAbort);
      serve.listeners.delete(listener);
    }
  }

  private readonly sessions = new Map<string, string>();

  private async ensureSession(serve: ServeHandle, spec: AgentTurnSpec): Promise<string> {
    const known = spec.engineSessionId ?? this.sessions.get(spec.sessionId);
    if (known !== undefined) {
      const exists = await fetch(`${serve.base}/session/${known}`, { signal: AbortSignal.timeout(5_000) });
      if (exists.ok) return known;
      this.sessions.delete(spec.sessionId);
    }
    const created = await fetch(`${serve.base}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: `composer:${spec.sessionId}` }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!created.ok) {
      throw new Error(`opencode session creation failed with ${created.status}`);
    }
    const session = (await created.json()) as { id: string };
    this.sessions.set(spec.sessionId, session.id);
    return session.id;
  }

  private async abort(serve: ServeHandle, spec: AgentTurnSpec): Promise<void> {
    const sessionId = this.sessions.get(spec.sessionId);
    if (sessionId === undefined) return;
    try {
      await fetch(`${serve.base}/session/${sessionId}/abort`, {
        method: 'POST',
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // The turn's poll loop notices an idle/error state regardless.
    }
  }

  /** The chat's serve process, spawned (and its SSE reader connected) on demand. */
  private async ensureServe(spec: AgentTurnSpec): Promise<ServeHandle> {
    const existing = this.serves.get(spec.sessionId);
    if (existing !== undefined && existing.alive && existing.connected) return existing;
    if (existing !== undefined) {
      existing.alive = false;
      try {
        existing.child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      this.serves.delete(spec.sessionId);
    }

    const port = await freePort();
    let resolveConnected!: () => void;
    const connectedPromise = new Promise<void>((resolve) => {
      resolveConnected = resolve;
    });
    const child = spawn(
      this.binary,
      ['serve', '--port', String(port)],
      {
        ...(spec.projectDirectory !== undefined ? { cwd: spec.projectDirectory } : {}),
        env: {
          ...process.env,
          COMPOSER_SERVER_URL: spec.serverUrl,
          COMPOSER_THREAD_ID: spec.sessionId,
          OPENCODE_CONFIG_CONTENT: JSON.stringify(mcpConfig(spec)),
          ...(spec.projectDirectory !== undefined
            ? { PWD: spec.projectDirectory, OLDPWD: spec.projectDirectory }
            : {}),
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    const serve: ServeHandle = {
      base: `http://127.0.0.1:${port}`,
      child,
      alive: true,
      connected: false,
      connectedPromise,
      listeners: new Set(),
    };
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', () => undefined);
    child.on('close', () => {
      serve.alive = false;
      this.serves.delete(spec.sessionId);
    });
    this.serves.set(spec.sessionId, serve);

    // Health-wait, then connect the SSE reader before any prompt fires.
    const deadline = Date.now() + this.spawnWaitMs;
    for (;;) {
      try {
        const health = await fetch(`${serve.base}/global/health`, { signal: AbortSignal.timeout(1_000) });
        if (health.ok) break;
      } catch {
        // Not up yet.
      }
      if (Date.now() > deadline) {
        serve.alive = false;
        child.kill('SIGKILL');
        this.serves.delete(spec.sessionId);
        throw new Error(`the server did not become healthy on port ${port}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    void readEvents(serve, () => {
      serve.connected = true;
      resolveConnected();
    }).finally(() => {
      // A dropped reader respawns on the next turn.
      serve.alive = false;
      serve.connected = false;
    });
    await connectedPromise;
    return serve;
  }

  close(): void {
    for (const [key, serve] of this.serves) {
      this.serves.delete(key);
      serve.alive = false;
      try {
        serve.child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
}

/** Reads the serve's SSE feed; resolves when the stream ends. */
async function readEvents(serve: ServeHandle, onConnected: () => void): Promise<void> {
  const response = await fetch(`${serve.base}/event`);
  if (!response.ok || response.body === null) return;
  onConnected();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line.startsWith('data: ')) continue;
      try {
        const event = JSON.parse(line.slice(6)) as ServeEvent;
        for (const listener of serve.listeners) listener(event);
      } catch {
        // Malformed frame — skip it.
      }
    }
  }
}

function toModel(model: string): { providerID: string; modelID: string } {
  const at = model.indexOf('/');
  return at < 0
    ? { providerID: model, modelID: model }
    : { providerID: model.slice(0, at), modelID: model.slice(at + 1) };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('listening', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))));
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });
}
