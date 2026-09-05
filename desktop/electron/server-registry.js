// The server gateway (v2: one server process for all projects): probe
// `GET /health` on the configured URI, spawn-on-refusal, wait for
// readiness.
//
// Plain Node (no electron imports) so the flow is exercisable outside the
// app process. The server URL: `$COMPOSER_SERVER_URL`, else the v1 default
// port. The server command: `$COMPOSER_SERVER_CMD` (a shell string, so a
// WSL-side server can be launched from the Windows desktop via `wsl`), else
// the workspace's built `server/dist/index.js` — spawned only when it
// exists (attach-only when the server lives on another host, e.g. WSL).

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PROBE_TIMEOUT_MS = 1_500;
const SPAWN_WAIT_MS = 15_000;
const SPAWN_POLL_MS = 250;

/** The server URI: `$COMPOSER_SERVER_URL`, else the default port. */
function serverUrl() {
  return process.env['COMPOSER_SERVER_URL'] ?? 'http://127.0.0.1:5214';
}

/** The workspace server entry: `<repo>/server/dist/index.js` when present. */
function serverEntry() {
  const candidate = path.join(__dirname, '..', '..', 'server', 'dist', 'index.js');
  return fs.existsSync(candidate) ? candidate : null;
}

/** `GET <uri>/health` — a 200 means a server owns the URI. */
async function healthy(uri, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const response = await fetch(`${uri.replace(/\/+$/, '')}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Finds (or spawns) the server and returns its entry once healthy —
 * `null` when the URI never answers and nothing spawnable exists
 * (attach-only deployments, e.g. the server inside WSL).
 */
async function discover() {
  const uri = serverUrl();
  if (await healthy(uri)) return entry(uri);

  const command = process.env['COMPOSER_SERVER_CMD'];
  const entryJs = serverEntry();
  if (command) {
    spawn(command, { stdio: 'ignore', shell: true, detached: true }).unref();
  } else if (entryJs !== null) {
    const logDir = path.join(__dirname, '..', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = fs.openSync(path.join(logDir, 'server.log'), 'a');
    const child = spawn(process.execPath, [entryJs], {
      stdio: ['ignore', logFile, logFile],
      detached: true,
      env: {
        ...process.env,
        COMPOSER_HTTP_ADDR: uri.replace(/^https?:\/\//, ''),
      },
    });
    child.unref();
    fs.closeSync(logFile);
  } else {
    return null; // attach-only: nothing to spawn
  }
  return (await waitHealthy(uri, SPAWN_WAIT_MS)) ? entry(uri) : null;
}

function entry(uri) {
  return { id: 'default', name: 'default', folder: '', uri };
}

/** Waits until `<uri>/health` answers or the budget runs out. */
async function waitHealthy(uri, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await healthy(uri, 1_000)) return true;
    await new Promise((resolve) => setTimeout(resolve, SPAWN_POLL_MS));
  }
  return false;
}

module.exports = { serverUrl, healthy, discover, waitHealthy, serverEntry };
