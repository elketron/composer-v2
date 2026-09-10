// The one generic write endpoint: the desktop's `{ type, on, body }` action
// envelope translates to a command (actions/index.ts) and lands on the
// validated processor. Domain rejections are NOT transport errors: `200
// { ok: false, rejectionCode, rejectionMessage }`; 400 is reserved for
// malformed requests.
import type { Hono } from 'hono';
import type { HttpDeps } from './deps.js';

import { fromAction, readScope } from '../actions/index.js';

export function registerActionRoute(app: Hono, deps: HttpDeps): void {
  const { processor } = deps;
  app.post('/action', async (context) => {
    const action = await context.req.json<unknown>().catch(() => undefined);
    const scope = readScope(action);
    const command = fromAction(action, scope);
    if (command === null) {
      return context.json({ error: 'malformed action', detail: 'unknown action shape' }, 400);
    }
    const outcome = await processor.execute(scope, command);
    if (outcome.ok) {
      // The outcome's payload fields ride the response (runId, pipelineId,
      // savedPath, transition, cards — the command's own echoes).
      return context.json({
        ok: true,
        ...('pipelineId' in outcome && outcome.pipelineId !== undefined ? { pipelineId: outcome.pipelineId } : {}),
        ...('runId' in outcome && outcome.runId !== undefined ? { runId: outcome.runId } : {}),
        ...('savedPath' in outcome && outcome.savedPath !== undefined ? { savedPath: outcome.savedPath } : {}),
        ...('transition' in outcome && outcome.transition !== undefined ? { transition: outcome.transition } : {}),
        ...('cards' in outcome && outcome.cards !== undefined ? { cards: outcome.cards } : {}),
      });
    }
    return context.json({
      ok: false,
      rejectionCode: outcome.rejection.code,
      rejectionMessage: outcome.rejection.message,
    });
  });
}
