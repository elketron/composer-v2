// The packaged-server bundle: one ESM file. The native SurrealDB engine's
// JS wrapper bundles in; its platform `.node` binaries stay external and
// are copied beside the bundle by the desktop's prepare-server script —
// the engine loads them relative to the bundle's own location.
import { build } from 'esbuild';
import { requireBanner } from './esbuild-fixups.mjs';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist-bundle/index.mjs',
  external: ['*.node'],
  banner: requireBanner,
  sourcemap: false,
  logLevel: 'info',
});
