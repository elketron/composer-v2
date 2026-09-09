// The serve engine's event translation (S22): serve SSE events in, turn
// events out. The process/HTTP orchestration around it is verified by the
// documented real-engine smokes (no real LLM or runtime in unit tests).

import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeServeClient } from '../src/engine/serve-client.js';
import { ServeProcessManager, type ServeHandle } from '../src/engine/serve-process.js';
import { OpenCodeServeEngine, ServeEventReducer } from '../src/engine/serve.js';
import type { AgentTurnEvent, AgentTurnSpec } from '../src/engine/types.js';

const SESSION = 'ses_thread';
const NO_EVENTS: AgentTurnEvent[] = [];
const reducer = () => new ServeEventReducer();

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function event(type: string, properties: Record<string, unknown>): { type: string; properties: Record<string, unknown> } {
  return { type, properties };
}

describe('ServeEventReducer', () => {
  it('streams text parts of assistant messages as deltas and settles them at idle', () => {
    const r = reducer();
    const events: AgentTurnEvent[] = [];
    const emit = (event: AgentTurnEvent): void => events.push(event);

    // The prompt echo lands first (role user) — it must never surface.
    r.apply(event('message.updated', { sessionID: SESSION, info: { id: 'msg_u', role: 'user' } }), SESSION, emit);
    r.apply(event('message.updated', { sessionID: SESSION, info: { id: 'msg_a', role: 'assistant' } }), SESSION, emit);
    r.apply(event('message.part.updated', { sessionID: SESSION, part: { id: 'prt_u', type: 'text', text: 'the question', messageID: 'msg_u' } }), SESSION, emit);
    expect(events).toEqual(NO_EVENTS);

    // A snapshot with the text so far emits the missing suffix…
    r.apply(event('message.part.updated', { sessionID: SESSION, part: { id: 'prt_a', type: 'text', text: 'Hello,', messageID: 'msg_a' } }), SESSION, emit);
    // …then token deltas arrive.
    r.apply(event('message.part.delta', { sessionID: SESSION, partID: 'prt_a', field: 'text', delta: ' world' }), SESSION, emit);
    r.apply(event('message.part.delta', { sessionID: SESSION, partID: 'prt_a', field: 'text', delta: '!' }), SESSION, emit);
    expect(events.map((event) => `${event.kind}:${'delta' in event ? event.delta : ''}`)).toEqual([
      'messageDelta:Hello,',
      'messageDelta: world',
      'messageDelta:!',
    ]);

    // The turn ends: every open part completes once.
    r.apply(event('session.idle', { sessionID: SESSION }), SESSION, emit);
    r.settle(emit);
    expect(events.at(-1)).toEqual({ kind: 'messageComplete', messageId: 'prt_a', text: 'Hello, world!' });

    const after = [...events];
    r.settle(emit);
    expect(events).toEqual(after); // settle is idempotent
  });

  it('ignores other sessions and non-text fields', () => {
    const r = reducer();
    const events: AgentTurnEvent[] = [];
    const emit = (event: AgentTurnEvent): void => events.push(event);
    r.apply(event('message.part.delta', { sessionID: 'ses_other', partID: 'prt_x', field: 'text', delta: 'no' }), SESSION, emit);
    r.apply(event('message.part.delta', { sessionID: SESSION, partID: 'prt_x', field: 'metadata', delta: 'no' }), SESSION, emit);
    r.apply(event('server.heartbeat', {}), SESSION, emit);
    expect(events).toEqual(NO_EVENTS);
  });

  it('tool parts announce once and settle once', () => {
    const r = reducer();
    const events: AgentTurnEvent[] = [];
    const emit = (event: AgentTurnEvent): void => events.push(event);
    r.apply(event('message.updated', { sessionID: SESSION, info: { id: 'msg_a', role: 'assistant' } }), SESSION, emit);

    r.apply(event('message.part.updated', {
      sessionID: SESSION,
      part: { id: 'prt_t', type: 'tool', tool: 'composer_read_file', messageID: 'msg_a', state: { status: 'running', input: { path: 'README.md' } } },
    }), SESSION, emit);
    r.apply(event('message.part.updated', {
      sessionID: SESSION,
      part: { id: 'prt_t', type: 'tool', tool: 'composer_read_file', messageID: 'msg_a', state: { status: 'running', input: { path: 'README.md' } } },
    }), SESSION, emit);
    r.apply(event('message.part.updated', {
      sessionID: SESSION,
      part: { id: 'prt_t', type: 'tool', tool: 'composer_read_file', messageID: 'msg_a', state: { status: 'completed', input: { path: 'README.md' }, output: 'contents' } },
    }), SESSION, emit);

    expect(events).toEqual([
      { kind: 'toolCall', toolCallId: 'prt_t', toolName: 'composer_read_file', args: { path: 'README.md' } },
      { kind: 'toolResult', toolCallId: 'prt_t', content: 'contents', isError: false },
    ]);
  });

  it('session.error carries the failure and distinguishes aborts', () => {
    const r = reducer();
    const events: AgentTurnEvent[] = [];
    const emit = (event: AgentTurnEvent): void => events.push(event);
    r.apply(event('session.error', { sessionID: SESSION, error: { name: 'ProviderError', data: { message: 'endpoint down' } } }), SESSION, emit);
    expect(r.failure()).toBe('endpoint down');
    expect(r.isAbort()).toBe(false);
    // No idle yet: the turn keeps waiting for its end signal.
    r.apply(event('session.idle', { sessionID: SESSION }), SESSION, emit);
    r.settle(emit);
    expect(events).toEqual(NO_EVENTS);

    const aborted = reducer();
    aborted.apply(event('session.error', { sessionID: SESSION, error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } }), SESSION, emit);
    expect(aborted.isAbort()).toBe(true);
  });

  it('a stopped turn still lands the partial text', () => {
    const r = reducer();
    const events: AgentTurnEvent[] = [];
    const emit = (event: AgentTurnEvent): void => events.push(event);
    r.apply(event('message.updated', { sessionID: SESSION, info: { id: 'msg_a', role: 'assistant' } }), SESSION, emit);
    r.apply(event('message.part.updated', { sessionID: SESSION, part: { id: 'prt_a', type: 'text', text: 'partial ans', messageID: 'msg_a' } }), SESSION, emit);
    r.apply(event('session.error', { sessionID: SESSION, error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } }), SESSION, emit);
    r.apply(event('session.idle', { sessionID: SESSION }), SESSION, emit);
    r.settle(emit);
    expect(events.at(-1)).toEqual({ kind: 'messageComplete', messageId: 'prt_a', text: 'partial ans' });
  });
});

describe('OpenCodeServeEngine cancellation', () => {
  const turnSpec = (signal?: AbortSignal): AgentTurnSpec => ({
    sessionId: 'thread-1',
    prompt: 'hello',
    serverUrl: 'http://composer.test',
    mcpScriptPath: '/tmp/mcp.js',
    agentName: 'assistant',
    timeoutMs: 50,
    ...(signal !== undefined ? { signal } : {}),
  });

  function stubServe(): ServeHandle {
    const serve: ServeHandle = {
      base: 'http://opencode.test',
      child: {} as ChildProcess,
      alive: true,
      connected: true,
      connectedPromise: Promise.resolve(),
      listeners: new Set(),
    };
    vi.spyOn(ServeProcessManager.prototype, 'ensure').mockResolvedValue(serve);
    vi.spyOn(OpenCodeServeClient.prototype, 'ensureSession').mockResolvedValue('ses_runtime');
    vi.spyOn(OpenCodeServeClient.prototype, 'prompt').mockResolvedValue(new Response(null, { status: 204 }));
    return serve;
  }

  it('ends at the turn timeout when the abort request fails and no terminal event arrives', async () => {
    vi.useFakeTimers();
    const serve = stubServe();
    const abort = vi.spyOn(OpenCodeServeClient.prototype, 'abort').mockRejectedValue(new Error('abort endpoint down'));
    const release = vi.spyOn(ServeProcessManager.prototype, 'release');
    const engine = new OpenCodeServeEngine();

    const resultPromise = engine.run(turnSpec(), () => undefined);
    await vi.advanceTimersByTimeAsync(50);

    await expect(resultPromise).resolves.toEqual({ ok: false, error: 'aborted', engineSessionId: 'ses_runtime' });
    expect(abort).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith('thread-1');
    expect(serve.listeners.size).toBe(0);
  });

  it('ends on AbortSignal without waiting for a terminal event', async () => {
    const serve = stubServe();
    const abort = vi.spyOn(OpenCodeServeClient.prototype, 'abort').mockResolvedValue();
    const release = vi.spyOn(ServeProcessManager.prototype, 'release');
    const controller = new AbortController();
    const engine = new OpenCodeServeEngine();

    const resultPromise = engine.run(turnSpec(controller.signal), () => undefined);
    await vi.waitFor(() => expect(serve.listeners.size).toBe(1));
    controller.abort();

    await expect(resultPromise).resolves.toEqual({ ok: false, error: 'aborted', engineSessionId: 'ses_runtime' });
    expect(abort).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith('thread-1');
    expect(serve.listeners.size).toBe(0);
  });
});
