// The gateway's protocol pin (S24), against real HTTP servers and real
// child processes (no fetch/child mocks): a compatible server is accepted;
// a skewed one is refused and — only when the spawn record proves the
// gateway spawned it — killed and replaced by the pinned build; a foreign
// one is left alone and discovery refuses loudly. Runs under the node
// vitest config (vitest.node.config.ts), not the Angular unit-test builder.

import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION as SERVER_PROTOCOL_VERSION } from '../../server/src/wire/events';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

interface RegistryModule {
  PROTOCOL_VERSION: number;
  serverUrl(): string;
  probeHealth(uri: string, timeoutMs?: number): Promise<Record<string, unknown> | null>;
  accepts(body: Record<string, unknown> | null): boolean;
  discover(): Promise<Record<string, string> | null>;
  readSpawnRecord(): { pid: number; protocol?: number } | null;
  writeSpawnRecord(pid: number): void;
}

const TOUCHED_ENV = [
  'COMPOSER_SERVER_URL',
  'COMPOSER_SERVER_CMD',
  'COMPOSER_SPAWN_RECORD',
  'COMPOSER_SPAWN_WAIT_MS',
  'COMPOSER_FAKE_PROTOCOL',
];

let dir: string;
let servers: Server[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'composer-gateway-'));
  for (const key of TOUCHED_ENV) delete process.env[key];
  process.env['COMPOSER_SPAWN_RECORD'] = join(dir, 'server.json');
  // Safety net: no test may sit in the default 15s spawn wait.
  process.env['COMPOSER_SPAWN_WAIT_MS'] = '4000';
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Re-imports the CJS registry so its module state (backoff, children) is fresh. */
async function freshRegistry(): Promise<RegistryModule> {
  vi.resetModules();
  const mod = (await import('../electron/server-registry.js')) as {
    default?: RegistryModule;
  } & RegistryModule;
  return (mod.default ?? mod) as RegistryModule;
}

function startServer(handler: Handler): Promise<{ server: Server; uri: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ server, uri: `http://127.0.0.1:${port}` });
    });
  });
}

const servingJson = (body: unknown): Handler => (_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
};

async function startServing(body: unknown): Promise<{ server: Server; uri: string }> {
  const started = await startServer(servingJson(body));
  servers.push(started.server);
  return started;
}

async function healthBody(uri: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${uri.replace(/\/+$/, '')}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function until(
  condition: () => Promise<boolean>,
  budgetMs = 5_000,
  stepMs = 100,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error('condition not met in time');
}

async function freePort(): Promise<number> {
  const { server } = await startServer((_req, res) => res.end());
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A standalone fake composer server: answers /health with a fixed protocol. */
function fakeServerScript(protocol: 'stale' | 'pinned'): string {
  if (protocol === 'stale') {
    return `
import { createServer } from 'node:http';
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ status: 'SERVING', protocol: 0, pid: process.pid }));
});
server.listen(Number(process.argv[2]), '127.0.0.1');
`;
  }
  return `
import { createServer } from 'node:http';
const attempt = () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      status: 'SERVING',
      protocol: Number(process.env['COMPOSER_FAKE_PROTOCOL']),
      pid: process.pid,
    }));
  });
  server.on('error', () => setTimeout(attempt, 150));
  server.listen(Number(process.argv[2]), '127.0.0.1');
};
attempt();
`;
}

describe('the gateway protocol pin (S24)', () => {
  it('the gateway pin matches the server wire version', async () => {
    const registry = await freshRegistry();
    expect(registry.PROTOCOL_VERSION).toBe(SERVER_PROTOCOL_VERSION);
  });

  it('a protocol-compatible server is accepted without spawning', async () => {
    const registry = await freshRegistry();
    const { uri } = await startServing({
      status: 'SERVING',
      protocol: SERVER_PROTOCOL_VERSION,
      pid: process.pid,
    });
    process.env['COMPOSER_SERVER_URL'] = uri;
    expect(await registry.discover()).toMatchObject({ uri });
  });

  it('a server predating the pin (no protocol field) is refused', async () => {
    const registry = await freshRegistry();
    const { uri } = await startServing({ status: 'SERVING' });
    process.env['COMPOSER_SERVER_URL'] = uri;
    expect(await registry.discover()).toBeNull();
  });

  it('a foreign stale server is refused and left alone', async () => {
    const registry = await freshRegistry();
    const { uri } = await startServing({ status: 'SERVING', protocol: 999, pid: 999_999 });
    process.env['COMPOSER_SERVER_URL'] = uri;
    // A record exists, but for a different pid: no proven ownership, no kill.
    registry.writeSpawnRecord(888_888);
    expect(await registry.discover()).toBeNull();
    // The foreign server still answers.
    expect(await healthBody(uri)).toMatchObject({ protocol: 999 });
    expect(registry.readSpawnRecord()).not.toBeNull();
  });

  it('a stale server the gateway spawned is killed and the pinned build respawns', async () => {
    const registry = await freshRegistry();
    const port = await freePort();
    const uri = `http://127.0.0.1:${port}`;

    // A leftover responder from a crashed earlier run would own the port.
    const leftover = await healthBody(uri);
    if (leftover !== null && Number.isInteger(leftover['pid'])) {
      try {
        process.kill(leftover['pid'] as number, 'SIGKILL');
      } catch {
        // Already gone.
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    const staleScript = join(dir, 'fake-stale.mjs');
    const currentScript = join(dir, 'fake-current.mjs');
    writeFileSync(staleScript, fakeServerScript('stale'));
    writeFileSync(currentScript, fakeServerScript('pinned'));

    const stale = spawn(process.execPath, [staleScript, String(port)], { stdio: 'ignore' });
    const exited = new Promise<void>((resolve) => stale.once('exit', () => resolve()));
    await until(async () => (await healthBody(uri)) !== null);
    // The record is exactly what a previous gateway generation wrote.
    registry.writeSpawnRecord(stale.pid!);

    process.env['COMPOSER_SERVER_URL'] = uri;
    process.env['COMPOSER_SERVER_CMD'] = `node '${currentScript}' ${port}`;
    process.env['COMPOSER_FAKE_PROTOCOL'] = String(SERVER_PROTOCOL_VERSION);
    process.env['COMPOSER_SPAWN_WAIT_MS'] = '8000';

    const entry = await registry.discover();
    expect(entry).toMatchObject({ uri });

    // The stale child died by the gateway's hand (a signal kill leaves
    // exitCode null and signalCode set); the record went with it.
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
    expect(stale.exitCode !== null || stale.signalCode !== null).toBe(true);
    expect(registry.readSpawnRecord()).toBeNull();

    // What answers now speaks the pinned protocol (the CMD spawn).
    expect(await healthBody(uri)).toMatchObject({ protocol: SERVER_PROTOCOL_VERSION });

    // Cleanup: the detached replacement is ours to stop (pid from /health).
    const current = await healthBody(uri);
    if (current !== null && Number.isInteger(current['pid'])) {
      try {
        process.kill(current['pid'] as number, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
  });

  it('a failed spawn still backs off (t11 intact)', async () => {
    const registry = await freshRegistry();
    const marker = join(dir, 'spawn-marker');
    const toucher = join(dir, 'toucher.mjs');
    writeFileSync(toucher, "import { appendFileSync } from 'node:fs';\nappendFileSync(process.argv[2], 'x\\n');\n");
    process.env['COMPOSER_SERVER_URL'] = 'http://127.0.0.1:5298';
    process.env['COMPOSER_SERVER_CMD'] = `node '${toucher}' '${marker}'`;
    process.env['COMPOSER_SPAWN_WAIT_MS'] = '1200';

    expect(await registry.discover()).toBeNull();
    expect(readFileSync(marker, 'utf8')).toBe('x\n');

    // The backoff window: an immediate rediscover spawns nothing.
    expect(await registry.discover()).toBeNull();
    expect(readFileSync(marker, 'utf8')).toBe('x\n');
  });

  it('the spawn record round-trips and rejects garbage', async () => {
    const registry = await freshRegistry();
    expect(registry.readSpawnRecord()).toBeNull();
    registry.writeSpawnRecord(4_242);
    expect(registry.readSpawnRecord()).toMatchObject({ pid: 4_242 });
    writeFileSync(process.env['COMPOSER_SPAWN_RECORD']!, 'not json');
    expect(registry.readSpawnRecord()).toBeNull();
  });
});
