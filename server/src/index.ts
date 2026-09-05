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

export interface Config {
  addr: string;
  dataDir: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    addr: env['COMPOSER_HTTP_ADDR'] ?? '127.0.0.1:5214',
    dataDir: env['COMPOSER_DATA_DIR'] ?? join(homedir(), '.local', 'share', 'composer-v2'),
  };
}

export async function boot(config: Config): Promise<{ close: () => Promise<void>; url: string }> {
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
  console.log(
    `composer v2 listening on http://${hostname}:${boundPort}` +
      ` (replayed ${rehydrated} events, ${bus.state.projects.size} projects)`,
  );
  return {
    url: `http://${hostname === '0.0.0.0' ? '127.0.0.1' : hostname}:${boundPort}`,
    close: async () => {
      // Open SSE streams count as connections; drop them so close resolves.
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.close();
    },
  };
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
