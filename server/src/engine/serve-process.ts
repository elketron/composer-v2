// The serve process pool (SRV-006): one long-lived `opencode serve` process
// per chat key. This manager owns spawn, health-wait, the SSE reader, the
// listener set, and teardown — nothing about HTTP sessions or turn policy.
// The streaming wire shape (`ServeEvent`) belongs here too; the turn-driven
// translation of it lives in `serve.ts`'s `ServeEventReducer`.

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mcpConfig } from './opencode.js';
import type { AgentTurnSpec } from './types.js';

export interface ServeEvent {
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

export interface ServePart {
  id?: string;
  type?: string;
  text?: string;
  tool?: string;
  messageID?: string;
  state?: { status?: string; input?: unknown; output?: unknown; metadata?: { error?: string } };
}

/** One serve process (per chat key) with its SSE reader and turn listeners. */
export interface ServeHandle {
  readonly base: string;
  readonly child: ChildProcess;
  alive: boolean;
  connected: boolean;
  readonly connectedPromise: Promise<void>;
  readonly listeners: Set<(event: ServeEvent) => void>;
}

export class ServeProcessManager {
  private readonly serves = new Map<string, ServeHandle>();

  constructor(
    private readonly binary: string,
    private readonly spawnWaitMs: number,
  ) {}

  /**
   * The chat's serve process, spawned (and its SSE reader connected) on
   * demand. A dead or stale serve is killed and replaced.
   */
  async ensure(spec: AgentTurnSpec): Promise<ServeHandle> {
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