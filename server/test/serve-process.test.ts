import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { ServeProcessManager } from '../src/engine/serve-process.js';
import type { AgentTurnSpec } from '../src/engine/types.js';

const spec: AgentTurnSpec = {
  sessionId: 'thread-1',
  prompt: 'hello',
  serverUrl: 'http://composer.test',
  mcpScriptPath: '/tmp/mcp.js',
  agentName: 'assistant',
  timeoutMs: 1_000,
};

function fakeChild(): ChildProcess & { kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as ChildProcess & { kill: ReturnType<typeof vi.fn> };
  child.kill = vi.fn(() => true);
  return child;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ServeProcessManager', () => {
  it.each([
    ['reader request failure', () => Promise.reject(new Error('socket closed')), 'socket closed'],
    ['non-OK reader response', () => Promise.resolve(new Response(null, { status: 503 })), 'event stream failed with 503'],
    ['reader response without a body', () => Promise.resolve(new Response(null)), 'event stream response had no body'],
  ])('rejects ensure promptly on %s', async (_name, eventResponse, message) => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/global/health')) return Promise.resolve(new Response(null));
      return eventResponse();
    }));

    const manager = new ServeProcessManager('fake-opencode', 1_000);
    await expect(manager.ensure(spec)).rejects.toThrow(message);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    manager.close();
  });

  it('clears the connection timeout once the event stream is open', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    let eventSignal: AbortSignal | undefined;
    let closeStream!: () => void;
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/global/health')) return Promise.resolve(new Response(null));
      eventSignal = init?.signal instanceof AbortSignal ? init.signal : undefined;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              closeStream = () => controller.close();
            },
          }),
        ),
      );
    }));

    const manager = new ServeProcessManager('fake-opencode', 10);
    const serve = await manager.ensure(spec);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(eventSignal?.aborted).toBe(false);
    expect(serve.connected).toBe(true);
    expect(serve.alive).toBe(true);
    closeStream();
    manager.close();
  });
});
