// The event stream: subscribe BEFORE the snapshot (live events may queue
// while the snapshot is written; folds are idempotent, so duplicates
// reconcile — the v1 rule). All writes serialize through one chain.
import type { Hono } from 'hono';
import type { HttpDeps } from './deps.js';
import { streamSSE } from 'hono/streaming';


import { snapshotEvents } from '../snapshot.js';

export function registerEventsRoute(app: Hono, deps: HttpDeps): void {
  const { bus } = deps;
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
}
