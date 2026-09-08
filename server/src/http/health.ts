// The gateway's probe (S24): the protocol pin lets the desktop's gateway refuse (and respawn) a stale server instead of attaching to one; the pid proves the recorded child's identity when the gateway kills its own spawn.

import type { Hono } from 'hono';
import { PROTOCOL_VERSION } from '../wire/events.js';
import type { HttpDeps } from './deps.js';

export function registerHealth(app: Hono): void {
  app.get('/health', (context) =>
    context.json({ status: 'SERVING', protocol: PROTOCOL_VERSION, pid: process.pid }),
  );
}
