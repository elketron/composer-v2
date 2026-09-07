const { contextBridge, ipcRenderer } = require('electron');

// The renderer's only door to the Electron main process: the server gateway
// (probe + spawn). Directory browsing is served by the server itself so a
// Windows desktop can select paths from a server running inside WSL.
contextBridge.exposeInMainWorld('composer', {
    serverUrl: process.env['COMPOSER_SERVER_URL'] ?? 'http://127.0.0.1:5214',
    projects: {
        discover() {
            return ipcRenderer.invoke('projects:discover');
        },
    },
});
