// The streaming opencode runtime (S22): a long-lived `opencode serve`
// process per chat (the assistant's thread) whose `/event` SSE feed carries
// token-level `message.part.delta` events — the `run` command buffers a
// turn's text and emits it once, which reads as no streaming at all.
//
// This file is the turn coordinator: process supervision is the shared
// `ServeProcessManager` (serve-process.ts), HTTP sessions/prompts are the
// `OpenCodeServeClient` (serve-client.ts), and the reducer below translates
// serve events into turn events. Continuity: the runtime's session id rides
// `engineSessionId` like the run engine's. Stop: the abort signal POSTs
// `/session/:id/abort`, while local cancellation ends the turn even if the
// request or terminal stream events never arrive.
//
// The wire facts were probed against opencode 1.18.25 (docs/milestones.md
// S22): `GET /event` yields `message.updated` (role map),
// `message.part.updated` (part snapshots: text so far, tool state),
// `message.part.delta` (token chunks), `session.error` (MessageAbortedError
// on a stop), and `session.idle` (the turn's end).

import { TextReducer, ToolReducer } from './reduce.js';
import { ServeProcessManager, type ServeEvent } from './serve-process.js';
import { OpenCodeServeClient } from './serve-client.js';
import type {
  AgentEngine,
  AgentTurnEvent,
  AgentTurnOutcome,
  AgentTurnSpec,
  UsageTokens,
} from './types.js';

export interface OpenCodeServeEngineOptions {
  /** The opencode binary (default: `opencode` on PATH). */
  binary?: string;
  /** Wall-clock cap per turn (default 10 minutes). */
  defaultTimeoutMs?: number;
  /** Health-wait budget per serve spawn. */
  spawnWaitMs?: number;
}

/**
 * The turn-driven translation of serve events into turn events (unit
 *-tested): text parts stream as deltas and settle once, tool parts
 * announce then settle, `session.error` records the failure,
 * `session.idle` ends the turn. The text/tool reduction is the shared
 * `engine/reduce.ts`; this class maps the serve wire onto it.
 */
export class ServeEventReducer {
  private readonly roles = new Map<string, string>();
  private readonly texts = new Map<string, TextReducer>();
  private readonly tools = new Map<string, ToolReducer>();
  private readonly usageByMessage = new Map<string, { cost: number; tokens: UsageTokens }>();
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
        // The assistant message's accumulated usage is an absolute snapshot;
        // upsert by message id so re-emitted snapshots never double-count.
        if (role !== 'assistant' || id === undefined) return;
        const info = properties.info;
        const cost = typeof info?.cost === 'number' ? info.cost : this.usageByMessage.get(id)?.cost ?? 0;
        const tokens = toTokens(info?.tokens);
        if (cost !== 0 || sumTokens(tokens) !== 0) {
          this.usageByMessage.set(id, { cost, tokens });
          emit({ kind: 'usage', cost: this.totalCost(), tokens: this.totalTokens() });
        }
        return;
      }
      case 'message.part.updated': {
        const part = properties.part;
        if (part?.id === undefined || part.messageID === undefined) return;
        // The user's own prompt rides the stream as a text part — only the
        // assistant's reply may surface.
        if (this.roles.get(part.messageID) !== 'assistant') return;
        if (part.type === 'text') {
          const delta = this.textOf(part.id).sync(part.text ?? '');
          if (delta !== null) emit({ kind: 'messageDelta', messageId: part.id, delta });
          return;
        }
        if (part.type === 'tool') {
          const status = part.state?.status;
          for (const turn of this.toolOf(part.id).step(
            {
              toolCallId: part.id,
              toolName: part.tool ?? 'tool',
              status,
              input: part.state?.input,
              output: part.state?.output,
              error: part.state?.metadata?.error,
            },
            false,
          )) {
            emit(turn);
          }
        }
        return;
      }
      case 'message.part.delta': {
        const partID = properties.partID;
        if (partID === undefined || properties.field !== 'text' || properties.delta === undefined) return;
        const part = this.texts.get(partID);
        if (part === undefined || part.isCompleted()) return;
        part.append(properties.delta);
        emit({ kind: 'messageDelta', messageId: partID, delta: properties.delta });
        return;
      }
      case 'session.diff': {
        const files = (properties.diff ?? [])
          .filter((entry): entry is { path: string; additions: number; deletions: number } =>
            typeof entry.path === 'string' && entry.path !== '')
          .map((entry) => ({
            path: entry.path,
            additions: entry.additions ?? 0,
            deletions: entry.deletions ?? 0,
          }));
        if (files.length > 0) emit({ kind: 'files', files });
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

  private totalCost(): number {
    let total = 0;
    for (const entry of this.usageByMessage.values()) total += entry.cost;
    return total;
  }

  private totalTokens(): UsageTokens {
    const tokens: UsageTokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    for (const entry of this.usageByMessage.values()) {
      tokens.input += entry.tokens.input;
      tokens.output += entry.tokens.output;
      tokens.reasoning += entry.tokens.reasoning;
      tokens.cacheRead += entry.tokens.cacheRead;
      tokens.cacheWrite += entry.tokens.cacheWrite;
    }
    return tokens;
  }

  private textOf(id: string): TextReducer {
    let text = this.texts.get(id);
    if (text === undefined) {
      text = new TextReducer();
      this.texts.set(id, text);
    }
    return text;
  }

  private toolOf(id: string): ToolReducer {
    let tool = this.tools.get(id);
    if (tool === undefined) {
      tool = new ToolReducer();
      this.tools.set(id, tool);
    }
    return tool;
  }

  /** Completes every open text part (the turn is over). */
  settle(emit: (event: AgentTurnEvent) => void): void {
    for (const [partID, part] of this.texts) {
      if (part.hasText() && !part.isCompleted()) {
        part.markComplete();
        emit({ kind: 'messageComplete', messageId: partID, text: part.fullText() });
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

export class OpenCodeServeEngine implements AgentEngine {
  readonly name = 'opencode-serve';
  private readonly defaultTimeoutMs: number;
  private readonly processes: ServeProcessManager;
  private readonly client = new OpenCodeServeClient();

  constructor(options: OpenCodeServeEngineOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 600_000;
    this.processes = new ServeProcessManager(
      options.binary ?? 'opencode',
      options.spawnWaitMs ?? 15_000,
    );
  }

  async run(
    spec: AgentTurnSpec,
    onEvent: (event: AgentTurnEvent) => void,
  ): Promise<AgentTurnOutcome> {
    let serve;
    try {
      serve = await this.processes.ensure(spec);
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

    let cancelTurn!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancelTurn = () => reject(TURN_ABORTED);
    });
    let cancelledLocally = false;
    const abortTurn = (): void => {
      if (cancelledLocally) return;
      cancelledLocally = true;
      cancelTurn();
      void this.client.abort(serve, spec).catch(() => undefined);
    };
    const timeout = setTimeout(() => {
      abortTurn();
    }, spec.timeoutMs > 0 ? spec.timeoutMs : this.defaultTimeoutMs);
    timeout.unref?.();
    const onAbort = (): void => {
      clearTimeout(timeout);
      abortTurn();
    };
    if (spec.signal?.aborted) onAbort();
    else spec.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      sessionId = await Promise.race([this.client.ensureSession(serve, spec), cancelled]);
      const prompt = await Promise.race([this.client.prompt(serve, sessionId, spec), cancelled]);
      if (prompt.status === 404) {
        // A stale runtime session (the serve restarted) — recreate once.
        this.client.resetSession(spec.sessionId);
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
        await Promise.race([new Promise((resolve) => setTimeout(resolve, 25)), cancelled]);
      }
    } catch (error) {
      if (error === TURN_ABORTED) {
        reducer.settle(onEvent);
        // The abort request is best-effort. Discard the runtime so a failed
        // abort cannot leave a busy session behind for the next turn.
        this.processes.release(spec.sessionId);
        return { ok: false, error: 'aborted', ...(sessionId !== undefined ? { engineSessionId: sessionId } : {}) };
      }
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

  close(): void {
    this.processes.close();
  }

  /** Tears down one chat's serve (the runner releases a step's process). */
  releaseSession(sessionId: string): void {
    this.processes.release(sessionId);
  }
}

const TURN_ABORTED = Symbol('turn aborted');

function toTokens(raw: unknown): UsageTokens {
  const tokens = (raw as { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } | undefined) ?? {};
  return {
    input: tokens.input ?? 0,
    output: tokens.output ?? 0,
    reasoning: tokens.reasoning ?? 0,
    cacheRead: tokens.cache?.read ?? 0,
    cacheWrite: tokens.cache?.write ?? 0,
  };
}

function sumTokens(tokens: UsageTokens): number {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite;
}
