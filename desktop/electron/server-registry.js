// The server gateway (v2: one server process for all projects): probe
// `GET /health` on the configured URI, refuse a protocol-skewed server,
// spawn-on-refusal, wait for readiness.
//
// Plain Node (no electron imports) so the flow is exercisable outside the
// app process. The server URL: `$COMPOSER_SERVER_URL`, else the v1 default
// port. The server command: `$COMPOSER_SERVER_CMD` (a shell string, so a
// WSL-side server can be launched from the Windows desktop via `wsl`), else
// the workspace's built `server/dist/index.js` — spawned only when it
// exists (attach-only when the server lives on another host, e.g. WSL).
//
// The protocol pin (S24): /health answers `{status, protocol, pid}` and a
// server is accepted only when `protocol` equals PROTOCOL_VERSION here —
// which must match server/src/wire/events.ts. A live server carrying any
// other version (older, newer, or predating the pin) is the stale-server
// skew (S21: after an upgrade the desktop attached to a server that
// predated its commands and every action 400'd for hours); it is refused,
// and killed + respawned only when the gateway can prove it spawned that
// exact process (the recorded child pid). A foreign server (attach-only,
// hand-run) is left alone: discovery refuses loudly and the desktop shows
// `backend unavailable` until the operator restarts it.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Bump together with server/src/wire/events.ts PROTOCOL_VERSION on any
// wire change (event catalog or commands).
const PROTOCOL_VERSION = 15;

const PROBE_TIMEOUT_MS = 1_500;
const SPAWN_POLL_MS = 250;
// t11: a failed spawn (dead URI the spawn can't satisfy — e.g. the WSL
// host is down) backs off, so a reconnect loop can't spawn a process per
// retry and orphan a pile of servers.
const SPAWN_RETRY_BACKOFF_MS = 30_000;
// Killing a recorded stale child (the pin's respawn): SIGTERM, then wait
// for the URI to go quiet before escalating.
const KILL_GRACE_MS = 5_000;
const KILL_POLL_MS = 100;

/** Our previous spawn (when we spawned one) and the in-flight attempt. */
let lastSpawnedChild = null;
let lastFailedSpawnAt = 0;
let spawnInFlight = null;

/** The server URI: `$COMPOSER_SERVER_URL`, else the default port. */
function serverUrl() {
  return process.env['COMPOSER_SERVER_URL'] ?? 'http://127.0.0.1:5214';
}

/** Spawn-wait budget: `$COMPOSER_SPAWN_WAIT_MS`, else 15s (test tunable). */
function spawnWaitMs() {
  const raw = Number(process.env['COMPOSER_SPAWN_WAIT_MS']);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}

/** The spawn record (the cross-restart ownership proof) — env-overridable. */
function spawnRecordPath() {
  return process.env['COMPOSER_SPAWN_RECORD'] ?? path.join(__dirname, '..', 'logs', 'server.json');
}

/** The workspace server entry: `<repo>/server/dist/index.js` when present.
 *  The packaged desktop points `COMPOSER_SERVER_ENTRY` at its bundled
 *  copy (see main.js) — this fallback only serves the dev checkout. */
function serverEntry() {
  const override = process.env['COMPOSER_SERVER_ENTRY'];
  if (override !== undefined && override !== '') return override;
  const candidate = path.join(__dirname, '..', '..', 'server', 'dist', 'index.js');
  return fs.existsSync(candidate) ? candidate : null;
}

/** The spawn's stdout/stderr sink: `$COMPOSER_SERVER_LOG`, else the dev
 *  checkout's `desktop/logs/server.log` (never written in a packaged
 *  app — main.js points the env at the user-data dir). */
function serverLogFile() {
  const override = process.env['COMPOSER_SERVER_LOG'];
  if (override !== undefined && override !== '') return override;
  return path.join(__dirname, '..', 'logs', 'server.log');
}

/**
 * `GET <uri>/health` — the parsed answer, or null when the URI doesn't
 * answer with a composer health document (dead, foreign 200, garbage).
 */
async function probeHealth(uri, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const response = await fetch(`${uri.replace(/\/+$/, '')}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    if (body === null || typeof body !== 'object' || body.status !== 'SERVING') return null;
    return body;
  } catch {
    return null;
  }
}

/** A server this gateway accepts: the health answer carries our protocol. */
function accepts(body) {
  return body !== null && body.protocol === PROTOCOL_VERSION;
}

/** `GET <uri>/health` — true when a protocol-compatible server owns the URI. */
async function healthy(uri, timeoutMs = PROBE_TIMEOUT_MS) {
  return accepts(await probeHealth(uri, timeoutMs));
}

function readSpawnRecord() {
  try {
    const raw = JSON.parse(fs.readFileSync(spawnRecordPath(), 'utf8'));
    if (raw !== null && typeof raw === 'object' && Number.isInteger(raw.pid) && raw.pid > 0) {
      return raw;
    }
  } catch {
    // Absent or unreadable: nothing we can prove.
  }
  return null;
}

function writeSpawnRecord(pid) {
  try {
    const file = spawnRecordPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${JSON.stringify({ pid, protocol: PROTOCOL_VERSION, spawnedAt: new Date().toISOString() })}\n`,
    );
  } catch {
    // Best effort: without a record the next generation just won't kill.
  }
}

function clearSpawnRecord() {
  try {
    fs.unlinkSync(spawnRecordPath());
  } catch {
    // Already gone.
  }
}

/**
 * The stale-server skew (S21/S24): a live server answered /health with a
 * protocol we don't speak. Kill it only when the record proves we spawned
 * that exact process, then wait for the URI to go quiet (SIGTERM, then
 * SIGKILL past the grace). Anything else is left alone — refuse instead.
 */
async function clearStaleServer(uri, body) {
  const pid =
    typeof body.pid === 'number' && Number.isInteger(body.pid) && body.pid > 0 ? body.pid : 0;
  const record = pid > 0 ? readSpawnRecord() : null;
  if (record === null || record.pid !== pid || pid === process.pid) return false;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already gone (or unsignalable) — the wait loop decides.
  }
  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, KILL_POLL_MS));
    if ((await probeHealth(uri, 500)) === null) {
      clearSpawnRecord();
      return true;
    }
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Gone between SIGTERM and now.
  }
  await new Promise((resolve) => setTimeout(resolve, KILL_POLL_MS * 5));
  if ((await probeHealth(uri, 500)) === null) {
    clearSpawnRecord();
    return true;
  }
  return false;
}

/**
 * Finds (or spawns) the server and returns its entry once healthy —
 * `null` when the URI never answers acceptably and nothing spawnable
 * exists (attach-only deployments, e.g. the server inside WSL), or when a
 * stale server owns the URI and can't be proven ours to replace.
 */
async function discover() {
  const uri = serverUrl();
  const body = await probeHealth(uri);
  if (accepts(body)) return entry(uri);

  if (body !== null) {
    // The URI is owned by a server we don't speak: the stale-server skew.
    if (!(await clearStaleServer(uri, body))) return null;
  }

  if (spawnInFlight !== null) return spawnInFlight;
  if (Date.now() - lastFailedSpawnAt < SPAWN_RETRY_BACKOFF_MS) return null;

  spawnInFlight = (async () => {
    try {
      // t11: kill our previous spawn before starting the next — a probe
      // failure while the child still lives means it is wedged, and two
      // servers would fight over the store.
      if (lastSpawnedChild !== null && lastSpawnedChild.exitCode === null) {
        try {
          lastSpawnedChild.kill('SIGTERM');
        } catch {
          // Already gone.
        }
      }
      lastSpawnedChild = null;

      const command = process.env['COMPOSER_SERVER_CMD'];
      const entryJs = serverEntry();
      if (command) {
        spawn(command, { stdio: 'ignore', shell: true, detached: true }).unref();
      } else if (entryJs !== null) {
        const logPath = serverLogFile();
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        const logFile = fs.openSync(logPath, 'a');
        const child = spawn(process.execPath, [entryJs], {
          stdio: ['ignore', logFile, logFile],
          detached: true,
          env: {
            ...process.env,
            COMPOSER_HTTP_ADDR: uri.replace(/^https?:\/\//, ''),
            // Run the child as plain Node: in a packaged app process.execPath
            // is the installed composer binary, and an Electron child would
            // boot the app instead of the server.
            ELECTRON_RUN_AS_NODE: '1',
          },
        });
        child.unref();
        fs.closeSync(logFile);
        lastSpawnedChild = child;
        // The ownership record: the next gateway generation may kill this
        // exact child when it turns stale (the protocol pin's respawn).
        writeSpawnRecord(child.pid);
      } else {
        return null; // attach-only: nothing to spawn
      }
      const ok = await waitHealthy(uri, spawnWaitMs());
      if (!ok) lastFailedSpawnAt = Date.now();
      return ok ? entry(uri) : null;
    } finally {
      spawnInFlight = null;
    }
  })();
  return spawnInFlight;
}

function entry(uri) {
  return { id: 'default', name: 'default', folder: '', uri };
}

/** Waits until `<uri>/health` answers acceptably or the budget runs out. */
async function waitHealthy(uri, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await healthy(uri, 1_000)) return true;
    await new Promise((resolve) => setTimeout(resolve, SPAWN_POLL_MS));
  }
  return false;
}

module.exports = {
  PROTOCOL_VERSION,
  serverUrl,
  probeHealth,
  accepts,
  healthy,
  discover,
  waitHealthy,
  serverEntry,
  readSpawnRecord,
  writeSpawnRecord,
};
