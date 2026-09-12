// Bundling shim: the store resolves its internal modules through computed
// dynamic imports (`./event-store.${moduleExtension}`) so the restart tests
// can load the raw .ts sources with node. esbuild enumerates both extension
// variants but only maps files that exist — without this shim the bundle's
// runtime picks the .js variant and throws at boot. Raw Node never loads it
// (the .ts branch wins) and tsc does not emit it (include is src/**/*.ts).
export { EventStore } from './event-store.ts';
