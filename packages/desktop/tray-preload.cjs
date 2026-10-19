// Bridge for the tray menu window (tray-menu.html) only: what it shows and what was clicked.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trayMenu', {
  onState: (cb) => ipcRenderer.on('konusgac:tray-state', (_event, state) => cb(state)),
  size: (width, height) => ipcRenderer.send('konusgac:tray-size', Number(width) | 0, Number(height) | 0),
  action: (name) => ipcRenderer.send('konusgac:tray-action', String(name)),
});
