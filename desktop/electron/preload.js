const { contextBridge, ipcRenderer } = require('electron');

// The renderer's only door to the Electron main process: the native
// directory picker and the server gateway (probe + spawn). The renderer
// itself does all REST + SSE traffic. Everything is plain JSON — no Node
// types cross the bridge.
contextBridge.exposeInMainWorld('composer', {
    serverUrl: process.env['COMPOSER_SERVER_URL'] ?? 'http://127.0.0.1:5214',
    projects: {
        pickDirectory() {
            return ipcRenderer.invoke('projects:pick-directory');
        },
        discover() {
            return ipcRenderer.invoke('projects:discover');
        },
    },
});
