// The dashboard reads: the project aggregation (runs, approvals, git) and
// the directory browsing the desktop's picker uses (server-native paths, so a
// Windows desktop can pick folders from a WSL server).
import type { Hono } from 'hono';
import type { HttpDeps } from './deps.js';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { dashboardProjects } from '../dashboard/index.js';


export function registerDashboardRoutes(app: Hono, deps: HttpDeps): void {
  const { bus } = deps;
  app.get('/dashboard', async (context) =>
    context.json({ projects: await dashboardProjects(bus.state) }),
  );

  // Directory selection belongs to the server's filesystem. The desktop may
  // run on another OS (notably Windows with a WSL server), so returning full
  // server-native paths here avoids translating paths in Electron.
  app.get('/directories', async (context) => {
    const requested = context.req.query('path')?.trim();
    const directory = resolve(requested || homedir());
    try {
      const children = await readdir(directory, { withFileTypes: true });
      const directories = (
        await Promise.all(
          children.map(async (entry) => {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) return { name: entry.name, path };
            if (!entry.isSymbolicLink()) return null;
            try {
              return (await stat(path)).isDirectory() ? { name: entry.name, path } : null;
            } catch {
              return null;
            }
          }),
        )
      )
        .filter((entry): entry is { name: string; path: string } => entry !== null)
        .sort((left, right) => left.name.localeCompare(right.name));
      const parent = dirname(directory);
      return context.json({
        directory,
        name: basename(directory) || directory,
        parent: parent === directory ? null : parent,
        directories,
      });
    } catch {
      return context.json({ error: 'directory is unavailable', directory }, 400);
    }
  });
}
