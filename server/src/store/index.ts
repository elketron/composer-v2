// Restart tests exercise this source file with raw Node, while production
// loads the emitted JavaScript. Resolve the matching internal module in both.
const moduleExtension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
const eventStoreModule = await import(
  `./event-store.${moduleExtension}`
) as typeof import('./event-store.js');

export const EventStore = eventStoreModule.EventStore;
export type EventStore = import('./event-store.js').EventStore;
