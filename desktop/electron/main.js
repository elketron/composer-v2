const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('node:path');

const registry = require('./server-registry');

const devServerUrl = process.env['COMPOSER_DEV_SERVER_URL'];

// One composer at a time: a second launch focuses the first window (the
// gateway would otherwise fight itself over the server's port). Dev
// checkouts often run several instances side by side — lock only installs.
const gotLock = app.isPackaged ? app.requestSingleInstanceLock() : true;
if (!gotLock) {
    app.quit();
}

// Packaged-mode paths: the bundled server, and writable per-user locations
// for the spawn record and the server log (the app bundle itself is a
// read-only asar archive; the dev defaults point at the checkout).
if (app.isPackaged) {
    process.env['COMPOSER_SERVER_ENTRY'] ??= path.join(
        process.resourcesPath,
        'server',
        'index.mjs',
    );
    process.env['COMPOSER_SPAWN_RECORD'] ??= path.join(app.getPath('userData'), 'server.json');
    process.env['COMPOSER_SERVER_LOG'] ??= path.join(app.getPath('userData'), 'server.log');
}

app.whenReady().then(() => {
    if (process.platform === 'win32') {
        app.setAppUserModelId('dev.composer.desktop');
    }
    createWindow();
});

// The debugger (electron-debug MCP smoke): opt-in Chrome DevTools remote
// debugging — `COMPOSER_DEBUG_PORT=<port>` exposes the CDP endpoint the
// MCP attaches to (same window, dev-server or dist boot).
const debugPort = process.env['COMPOSER_DEBUG_PORT'];
if (debugPort) {
    app.commandLine.appendSwitch('remote-debugging-port', debugPort);
}

// The renderer talks to the server directly over REST + SSE; main owns the
// native surfaces the renderer cannot reach: the directory picker and the
// server gateway (probe + spawn-on-refusal).
ipcMain.handle('projects:pick-directory', async (ipcEvent) => {
    const window = BrowserWindow.fromWebContents(ipcEvent.sender);
    const options = { properties: ['openDirectory'] };
    const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    const directory = result.filePaths[0];
    return { directory, name: path.basename(directory) };
});

// One startup pass: probe the server URI, spawn it on refusal, wait for
// readiness. The renderer attaches one SSE stream.
ipcMain.handle('projects:discover', async () => registry.discover());

function createWindow() {
    const win = new BrowserWindow({
        width: 1440,
        height: 900,
        backgroundColor: '#0e0e0f',
        title: 'composer',
        icon: iconPath(),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    if (devServerUrl) {
        win.loadURL(devServerUrl);
    } else {
        win.loadFile(path.join(__dirname, '..', 'dist', 'composer-desktop', 'browser', 'index.html'));
    }
}

/** The app icon where the platform expects one (build resources ship it). */
function iconPath() {
    try {
        const resources = process.resourcesPath;
        if (resources === undefined) return undefined;
        const candidate = path.join(resources, 'icon.png');
        return require('node:fs').existsSync(candidate) ? candidate : undefined;
    } catch {
        return undefined;
    }
}

// A second launch focuses the existing window instead of fighting over
// the server's port (the single-instance lock already quit it).
app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (window !== undefined) {
        if (window.isMinimized()) window.restore();
        window.focus();
    }
});

app.on('window-all-closed', () => {
    app.quit();
});
