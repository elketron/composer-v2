// The HTTP surface (v1 architecture.md): one generic write endpoint, one
// event stream, and health. Domain rejections are NOT transport errors:
// `200 { ok: false, rejectionCode, rejectionMessage }`; 400 is reserved
// for malformed requests.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { Bus } from './bus.js';
import type { Processor } from './processor.js';
import type { Command } from './wire/commands.js';
import { snapshotEvents } from './snapshot.js';

export function router(bus: Bus, processor: Processor): Hono {
  const app = new Hono();

  // Permissive CORS (the v1 rule): the desktop renderer connects directly,
  // including cross-origin when the server runs in WSL and the desktop on
  // Windows.
  app.use('*', cors());

  app.get('/health', (context) => context.json({ status: 'SERVING' }));

  app.post('/action', async (context) => {
    const action = await context.req.json<unknown>().catch(() => undefined);
    const command = fromAction(action);
    if (command === null) {
      return context.json({ error: 'malformed action', detail: 'unknown action shape' }, 400);
    }
    const scope = readScope(action);
    const outcome = await processor.execute(scope, command);
    if (outcome.ok) {
      return context.json({ ok: true });
    }
    return context.json({
      ok: false,
      rejectionCode: outcome.rejection.code,
      rejectionMessage: outcome.rejection.message,
    });
  });

  app.get('/events', (context) => {
    const projectId = context.req.query('projectId');
    return streamSSE(context, async (stream) => {
      // Subscribe BEFORE the snapshot: live events may queue while the
      // snapshot is written; folds are idempotent, so duplicates reconcile
      // (the v1 rule). All writes serialize through one chain.
      let closed = false;
      let write = Promise.resolve();
      const enqueue = (data: string): void => {
        write = write
          .then(() => (closed ? undefined : stream.writeSSE({ data })))
          .catch(() => {
            closed = true;
          });
      };
      const unsubscribe = bus.subscribe((frame) => {
        if (projectId === undefined || frame.projectId === undefined || frame.projectId === projectId) {
          enqueue(JSON.stringify(frame));
        }
      });
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
      });

      for (const frame of snapshotEvents(bus.state, projectId)) {
        enqueue(JSON.stringify(frame));
      }
      await write;

      // The stream lives until the client disconnects.
      while (!closed) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 250);
          timer.unref?.();
        });
      }
    });
  });

  return app;
}

/** The action envelope → command mapping (v1 actions.rs, mechanical). */
export function fromAction(action: unknown): Command | null {
  if (typeof action !== 'object' || action === null) return null;
  const record = action as Record<string, unknown>;
  const type = readString(record, 'type');
  const on = readString(record, 'on');
  const body = readObject(record, 'body');
  if (type === undefined || on === undefined || body === undefined) return null;

  const str = (key: string): string | undefined => readString(body, key);
  const bool = (key: string): boolean | undefined => {
    const value = body[key];
    return typeof value === 'boolean' ? value : undefined;
  };

  switch (`${type}:${on}`) {
    case 'create:project':
      return {
        type: 'requestProjectCreate',
        name: str('name') ?? '',
        ...(str('directory') !== undefined ? { directory: str('directory') } : {}),
      };
    case 'update:project': {
      const projectId = str('id') ?? '';
      if (str('directory') !== undefined) {
        return { type: 'requestProjectSetDirectory', projectId, directory: str('directory') ?? '' };
      }
      if (bool('active') === true) {
        return { type: 'requestProjectActivate', projectId };
      }
      return null;
    }
    default:
      return null;
  }
}

function readScope(action: unknown): string | undefined {
  if (typeof action !== 'object' || action === null) return undefined;
  const value = (action as Record<string, unknown>)['projectId'];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readObject(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}
