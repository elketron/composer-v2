const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('node:path');

const registry = require('./server-registry');

const devServerUrl = process.env['COMPOSER_DEV_SERVER_URL'];

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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    app.quit();
});
