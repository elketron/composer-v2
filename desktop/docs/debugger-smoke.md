# Debugger wiring — smoke test (2026-09-05)

Card T-1 · "Wire the debugger" · Electron MCP smoke card.

## The wiring

- `desktop/electron/main.js`: `COMPOSER_DEBUG_PORT=<port>` opts the window
  into Chrome DevTools remote debugging
  (`app.commandLine.appendSwitch('remote-debugging-port', port)`). Same
  window, dev-server or dist boot; unset → unchanged behavior.
- `desktop/package.json`: `start:electron:debug` — the dev flow
  (`ng serve` + electron) with `COMPOSER_DEBUG_PORT=9222`.

The electron-debug MCP then attaches over the CDP endpoint
(`start_app`/`attach`, debugPort 9222).

## Smoke (MCP against the dist boot, Electron 43.6.0)

- `start_app` (desktop/, debugPort 9222): one page target,
  `file://.../dist/composer-desktop/browser/#/board`, title `composer`.
- `diagnose`: debug port reachable, target debuggable, no console errors.
- `evaluate`: document complete, `window.composer` bridge exposed
  (serverUrl `http://127.0.0.1:5214`), `app-root` rendered.
- Console: only Electron's dev CSP warning (expected unpackaged).
- Screenshot: the live board renders (server-attached, `demo` project) —
  card T-1 itself visible in the DESIGN lane.
- `query_selector` + `click` on the rail: route `#/board` → `#/settings`,
  view title follows (`composer v2 › settings`).
- `stop_app` clean.

Result: the debugger surface is wired and exercised end to end — start,
targets, console, screenshot, evaluate, click — with the app booted from
its built dist. `pnpm verify` green (server 65, desktop 144).
