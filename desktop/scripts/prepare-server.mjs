// Stages the packaged server next to the app's build outputs:
//   packaging/server/index.mjs                    — the esbuild bundle
//   packaging/server/surrealdb-node.<platform>.node — the native engine
// electron-builder copies the directory into the app's resources
// (extraResources in electron-builder.yml); the gateway spawns index.mjs
// with ELECTRON_RUN_AS_NODE and the engine loads its binding relative to
// the bundle. Run: node scripts/prepare-server.mjs
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(desktop, '..');
const stage = join(desktop, 'packaging', 'server');
// Bindings to ship (the package carries every platform; the rest is dead
// weight in the installer). Override with COMPOSER_BINDINGS=a,b.
const keep = (process.env['COMPOSER_BINDINGS'] ?? 'linux-x64-gnu,linux-x64-musl,win32-x64-msvc,win32-arm64-msvc')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name !== '');

// The bundle comes from the workspace's server project — its esbuild
// devDependency runs it (resolved through the server package, no pnpm
// shell-out from this npm-managed project).
{
  const serverRequire = createRequire(join(repo, 'server', 'package.json'));
  const { build } = await serverRequire('esbuild');
  await build({
    entryPoints: [join(repo, 'server', 'src', 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: join(repo, 'server', 'dist-bundle', 'index.mjs'),
    external: ['*.node'],
    logLevel: 'warning',
  });
}
const bundle = join(repo, 'server', 'dist-bundle', 'index.mjs');
const nativeDist = join(repo, 'server', 'node_modules', '@surrealdb', 'node', 'dist');
if (!existsSync(bundle)) throw new Error('the server bundle is missing');
if (!existsSync(nativeDist)) throw new Error('@surrealdb/node is not installed');

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(bundle, join(stage, 'index.mjs'));
for (const file of readdirSync(nativeDist)) {
  if (!file.endsWith('.node')) continue;
  if (!keep.some((binding) => file.includes(binding))) continue;
  cpSync(join(nativeDist, file), join(stage, file));
}
console.log(`server staged at ${stage} (bindings: ${keep.join(', ')})`);
