// The single bridge between the web client and the desktop shell.
// Exposes fixed functions only; channel names are never chosen by the page,
// and the main process checks which page every call comes from.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('konusgac', {
  notify: (title, body) => ipcRenderer.send('konusgac:notify', String(title), String(body)),
  setBadge: (count, flash = true) => ipcRenderer.send('konusgac:set-badge', Number(count) | 0, flash !== false),
  info: () => ipcRenderer.invoke('konusgac:info'),
  changeServer: () => ipcRenderer.send('konusgac:change-server'),
  setServer: (url) => ipcRenderer.invoke('konusgac:set-server', String(url)),
  retry: () => ipcRenderer.send('konusgac:retry'),
  useDefaultServer: () => ipcRenderer.send('konusgac:use-default-server'),
  setZoom: (factor) => ipcRenderer.send('konusgac:set-zoom', Number(factor)),
  getWindowSettings: () => ipcRenderer.invoke('konusgac:get-window-settings'),
  setWindowSettings: (patch) => ipcRenderer.send('konusgac:set-window-settings', patch),
  setShortcuts: (keys) => ipcRenderer.send('konusgac:set-shortcuts', keys),
  screenSources: () => ipcRenderer.invoke('konusgac:screen-sources'),
  openGoogleSignIn: () => ipcRenderer.send('konusgac:google-sign-in'),
  setTrayState: (state) => ipcRenderer.send('konusgac:tray-state', { muted: !!state?.muted, deafened: !!state?.deafened }),
  onNativeMenu: (cb) => ipcRenderer.on('konusgac:native-menu', (_event, params) => cb(params)),
  nativeMenuAction: (action, arg) => ipcRenderer.send('konusgac:native-menu-action', String(action), arg === undefined ? undefined : String(arg)),
  pickScreenSource: (id, audio) => ipcRenderer.invoke('konusgac:pick-screen-source', String(id), audio === true),
  onShortcut: (cb) => ipcRenderer.on('konusgac:shortcut', (_event, name) => cb(String(name))),
});
