// The knowledge reads (Phase 9): straight reads over the library's files.
// Writes ride the knowledge commands through the processor.
import type { Hono } from 'hono';
import type { HttpDeps } from './deps.js';


export function registerKnowledgeRoutes(app: Hono, deps: HttpDeps): void {
  const { knowledge } = deps;
  // Knowledge reads (Phase 9): straight reads over the library's files.
  // Writes ride the knowledge commands through the processor.
  app.get('/knowledge', (context) => {
    if (knowledge === undefined) {
      return context.json({ error: 'knowledge storage is unavailable' });
    }
    return context.json({ entries: knowledge.list() });
  });

  app.get('/knowledge/content', (context) => {
    if (knowledge === undefined) {
      return context.json({ error: 'knowledge storage is unavailable' });
    }
    const path = context.req.query('path') ?? '';
    const result = knowledge.read(path);
    if (!result.ok) {
      return context.json({ error: result.error });
    }
    return context.json({
      entry: { ...result.value.info, content: result.value.content, body: result.value.body },
    });
  });

  app.get('/knowledge/search', (context) => {
    if (knowledge === undefined) {
      return context.json({ error: 'knowledge storage is unavailable' });
    }
    const query = context.req.query('q') ?? '';
    return context.json({
      results: knowledge.search(query).map((result) => ({
        ...result.info,
        snippet: result.snippet,
        score: result.score,
      })),
    });
  });
}
