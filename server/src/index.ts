// Composer v2 server: one process, many projects. Boot order: open the
// store → rehydrate every registered project's log into the fold → serve.
// The chosen address: $COMPOSER_HTTP_ADDR, else 127.0.0.1:5214 (the v1
// default). Data: $COMPOSER_DATA_DIR, else ~/.local/share/composer-v2.

import { serve } from '@hono/node-server';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { Bus } from './bus.js';
import { EventStore } from './store.js';
import { Processor } from './processor.js';
import { router } from './http.js';
import { PlanningOrchestrator } from './planning.js';
import { OpenCodeEngine } from './engine/opencode.js';
import { FakeEngine } from './engine/fake.js';
import type { AgentEngine } from './engine/types.js';
import type { ComposerCaller } from './engine/planner-tools.js';

export interface Config {
  addr: string;
  dataDir: string;
  /** Test/dev hook: build the agent engine over the booted processor. */
  engineFactory?: (caller: ComposerCaller) => AgentEngine;
  /** Off switch for the planning turn (the v1 PLANNER_ENABLED kill switch). */
  plannerEnabled?: boolean;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    addr: env['COMPOSER_HTTP_ADDR'] ?? '127.0.0.1:5214',
    dataDir: env['COMPOSER_DATA_DIR'] ?? join(homedir(), '.local', 'share', 'composer-v2'),
  };
}

export async function boot(config: Config): Promise<{
  close: () => Promise<void>;
  url: string;
  stopPlanning: () => void;
}> {
  const store = new EventStore();
  await store.connect(config.dataDir);
  const bus = new Bus(store);
  const rehydrated = await bus.rehydrate();
  const processor = new Processor(bus);

  const [hostname, port] = config.addr.includes(':')
    ? (config.addr.split(':') as [string, string])
    : ['127.0.0.1', config.addr];
  const server = serve({ fetch: router(bus, processor).fetch, hostname, port: Number(port) });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : Number(port);
  const url = `http://${hostname === '0.0.0.0' ? '127.0.0.1' : hostname}:${boundPort}`;

  // The planning turn (S2): user messages → agent turns → streamed replies.
  // The kill switch and the fake engine keep the boot no-LLM when asked.
  const plannerEnabled = config.plannerEnabled ?? process.env['COMPOSER_PLANNER_ENABLED'] !== '0';
  let stopPlanning: () => void = () => undefined;
  if (plannerEnabled) {
    const engine =
      config.engineFactory?.(processor) ??
      (process.env['COMPOSER_FAKE_ENGINE'] === '1'
        ? new FakeEngine(processor)
        : new OpenCodeEngine());
    const orchestrator = new PlanningOrchestrator(bus, engine, {
      serverUrl: url,
      mcpScriptPath: mcpScriptPath(),
    });
    orchestrator.start();
    stopPlanning = () => orchestrator.stop();
  }

  console.log(
    `composer v2 listening on ${url}` +
      ` (replayed ${rehydrated} events, ${bus.state.projects.size} projects)` +
      (plannerEnabled ? ' [planner: on]' : ' [planner: off]'),
  );
  return {
    url,
    close: async () => {
      stopPlanning();
      // Open SSE streams count as connections; drop them so close resolves.
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.close();
    },
    stopPlanning,
  };
}

/** The MCP child script (dist/mcp.js) — resolved from either the src or dist layout. */
function mcpScriptPath(): string {
  return process.env['COMPOSER_MCP_SCRIPT'] ?? fileURLToPath(new URL('../dist/mcp.js', import.meta.url));
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (isMain) {
  const config = configFromEnv();
  boot(config).catch((error) => {
    console.error('boot failed:', error);
    process.exit(1);
  });
}
