// The esbuild fixups the server bundle needs (shared by the server's own
// bundle script and the desktop's prepare-server staging):
//
// requireBanner — bundled CJS dependencies (the Pi SDK among them) call
// require() on node builtins at runtime; an ESM bundle has no ambient
// require, so inject one. The aliased name avoids colliding with the
// SDK chunks' own createRequire imports.
//
// The store's computed dynamic imports (`./event-store.${moduleExtension}`)
// need the one-line .js re-export shims beside the store sources — esbuild
// enumerates glob candidates internally, bypassing plugin resolution, so a
// plugin cannot supply the missing .js variants.
export const requireBanner = {
  js: "import { createRequire as composerCreateRequire } from 'node:module';\nconst require = composerCreateRequire(import.meta.url);",
};