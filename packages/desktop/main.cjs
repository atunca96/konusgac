// Konuşgaç desktop shell: a thin window around the web client.
// The renderer gets no Node access; the only bridge is the allowlisted IPC in preload.cjs.
//
// Two modes:
// - Installed app (packaged): connects to a Konuşgaç server whose address the user enters
//   once (connect.html); it is kept in <userData>/ayarlar.json and can be changed later.
// - From the repository (npm run desktop): local mode, which starts the repository's own
//   server unless one is already listening, and stops it on quit. KONUSGAC_URL overrides both.
const { app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, Notification, screen, session, shell, Tray } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SETTINGS = path.join(app.getPath('userData'), 'ayarlar.json');
const CONNECT_PAGE = pathToFileURL(path.join(__dirname, 'connect.html')).href;
const SPLASH_PAGE = pathToFileURL(path.join(__dirname, 'splash.html')).href;

// KONUSGAC_LOCAL=0 makes a development copy behave like the installed app (for trying the start flow).
const LOCAL = !process.env.KONUSGAC_URL && !app.isPackaged && process.env.KONUSGAC_LOCAL !== '0';
// Konuşgaç's own server: an installed app connects to it without asking anything. People who run
// their own server can switch to it from the settings (stored as serverUrl).
const DEFAULT_SERVER = require('./package.json').konusgac.defaultServer;
const APP_URL = process.env.KONUSGAC_URL || (LOCAL ? 'http://localhost:3001' : readSettings().serverUrl || DEFAULT_SERVER);
const APP_ORIGIN = APP_URL ? new URL(APP_URL).origin : null;

// Microphones only work on secure origins. A server on the local network (http://192.168.x.x)
// is not one, so the chosen server is trusted explicitly; it is the only origin the window loads.
if (APP_ORIGIN && APP_ORIGIN.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(APP_ORIGIN)) {
  app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', APP_ORIGIN);
}

// Window settings from the app's settings page (Windows Ayarları); hardware acceleration needs a restart.
const WINDOW_DEFAULTS = { openAtLogin: false, startMinimized: false, minimizeToTray: true, hardwareAcceleration: true };
const windowSettings = () => ({ ...WINDOW_DEFAULTS, ...(readSettings().window ?? {}) });
if (!windowSettings().hardwareAcceleration) app.disableHardwareAcceleration();

let win = null;
let tray = null;
let quitting = false;
let server = null; // child process we own, if any

app.setAppUserModelId('com.konusgac.app'); // taskbar grouping and notification identity on Windows

// konusgac:// links open this app: Google sign-in in the system browser ends with
// konusgac://giris?kod=<code>, which brings the code back here.
if (app.isPackaged) app.setAsDefaultProtocolClient('konusgac');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    handleDeepLink(argv);
  });
  app.whenReady().then(start);
}

// The sign-in code from a konusgac:// link: the web client trades it for a session (?giris=).
let pendingSignIn = null;
function handleDeepLink(argv) {
  const link = argv.find((a) => typeof a === 'string' && a.startsWith('konusgac://'));
  if (!link) return;
  let code = null;
  try {
    code = new URL(link).searchParams.get('kod');
  } catch {}
  if (!code || !/^[A-Za-z0-9_-]{20,100}$/.test(code) || !APP_URL) return;
  const target = `${APP_ORIGIN}/?giris=${code}`;
  if (win) void win.loadURL(target);
  else pendingSignIn = target;
}
handleDeepLink(process.argv); // started by the link itself

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify({ ...readSettings(), ...patch }, null, 2));
}

async function start() {
  // Spelling is checked in Turkish and English.
  session.defaultSession.setSpellCheckerLanguages(['tr', 'en-US']);
  // Only the chosen server may use the microphone, camera, screen capture and notifications;
  // nothing else is granted.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = details.requestingUrl ? new URL(details.requestingUrl).origin : '';
    const media = permission === 'media' && (details.mediaTypes ?? []).every((t) => t === 'audio' || t === 'video');
    callback(origin === APP_ORIGIN && (media || permission === 'notifications' || permission === 'display-capture'));
  });

  // Screen sharing: the page shows its own picker (konusgac:screen-sources), names the chosen
  // screen or window (konusgac:pick-screen-source), then calls getDisplayMedia, which lands here.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    // Electron refuses a request answered without a stream, and also throws about it.
    const deny = () => {
      try {
        callback({});
      } catch {}
    };
    const pick = pickedSource;
    pickedSource = null;
    let origin = '';
    try {
      origin = new URL(request.frame?.url || request.securityOrigin).origin;
    } catch {}
    if (!pick || origin !== APP_ORIGIN) return deny();
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] }).catch(() => []);
    const source = sources.find((s) => s.id === pick.id);
    if (!source) return deny();
    // System sound comes with the picture on Windows only.
    callback({ video: source, ...(pick.audio && process.platform === 'win32' ? { audio: 'loopback' } : {}) });
  });

  // Updates are looked for once the app is up, not while it starts.
  if (app.isPackaged) setTimeout(startUpdates, 10_000);

  // The window appears at once with a "Konuşgaç açılıyor…" screen; the server loads behind it. If
  // it cannot be reached, the "Bağlanılamadı / Tekrar dene" page replaces it (see createWindow).
  if (!LOCAL) {
    createWindow(SPLASH_PAGE);
    void win.loadURL(pendingSignIn ?? APP_URL);
    pendingSignIn = null;
    return;
  }

  // Development copy: start the local server first if it is not running.
  createWindow(SPLASH_PAGE);
  if (!(await serverUp(APP_ORIGIN))) {
    try {
      startServer();
      await waitForServer(30_000);
    } catch (err) {
      dialog.showErrorBox('Konuşgaç başlatılamadı', `${err.message}\n\nAyrıntılar: ${logPath()}`);
      app.quit();
      return;
    }
  }
  void win.loadURL(APP_URL);
}

// The bundled page for "server unreachable" and "another server"; ozel=1 when not on the default one.
function connectPage(params = {}) {
  const custom = !LOCAL && !process.env.KONUSGAC_URL && APP_ORIGIN !== new URL(DEFAULT_SERVER).origin;
  const q = new URLSearchParams({ ...params, ...(custom ? { ozel: '1' } : {}) });
  return `${CONNECT_PAGE}?${q}`;
}

// Updates come from konusgac.com/indir (latest.yml there), downloaded in the background. Closing
// the window only hides the app in the tray, so "install on quit" alone would rarely happen: when
// an update is ready the app asks whether to restart now. Checked after start and every hour.
let updater = null;
function startUpdates() {
  const { autoUpdater } = require('electron-updater');
  updater = autoUpdater;
  autoUpdater.autoInstallOnAppQuit = true; // "Sonra" still installs at the next real quit
  let asked = false;
  autoUpdater.on('update-downloaded', async (info) => {
    if (asked) return;
    asked = true;
    const { response } = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: 'info',
      title: 'Konuşgaç güncellemesi',
      message: `Konuşgaç ${info.version} hazır.`,
      detail: 'Yeniden başlatınca yeni sürüm kurulur; birkaç saniye sürer.',
      buttons: ['Şimdi yeniden başlat', 'Sonra'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      quitting = true;
      autoUpdater.quitAndInstall(true, true); // silently, then open the new version
    }
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {}); // offline: try again later
  void check();
  setInterval(check, 60 * 60 * 1000).unref();
}

// True if a Konuşgaç server answers at origin.
async function serverUp(origin) {
  try {
    const res = await fetch(`${origin}/api/config`, { signal: AbortSignal.timeout(4000) });
    const body = res.ok ? await res.json() : null;
    return !!body && typeof body.registration === 'string';
  } catch {
    return false;
  }
}

function logPath() {
  return path.join(REPO_ROOT, 'data', 'server.log');
}

function startServer() {
  const tsx = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const entry = path.join(REPO_ROOT, 'packages', 'server', 'src', 'index.ts');
  if (!fs.existsSync(path.join(REPO_ROOT, 'packages', 'web', 'dist', 'index.html'))) {
    throw new Error('Web arayüzü derlenmemiş. Proje klasöründe "npm run build" çalıştır.');
  }
  fs.mkdirSync(path.dirname(logPath()), { recursive: true });
  const log = fs.openSync(logPath(), 'a');
  // Plain Node from PATH runs the server; Electron's own runtime is kept for the UI.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  server = spawn('node', [tsx, entry], { cwd: REPO_ROOT, windowsHide: true, stdio: ['ignore', log, log], env });
  server.on('error', (err) => {
    server = null;
    if (!win) return;
    dialog.showErrorBox('Konuşgaç sunucusu durdu', err.message);
  });
  server.on('exit', () => (server = null));
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await serverUp(APP_ORIGIN)) return;
    if (LOCAL && !server) throw new Error('Sunucu süreci beklenmedik şekilde kapandı.');
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Sunucu zamanında yanıt vermedi.');
}

app.on('will-quit', () => {
  if (server) server.kill();
});

function createWindow(startUrl = APP_URL) {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    icon: path.join(__dirname, 'icon.png'),
    minWidth: 940,
    minHeight: 560,
    title: 'Konuşgaç',
    backgroundColor: '#23262e',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // Keep the window on the app's origin; everything else opens in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    if (target.origin !== APP_ORIGIN && !isConnectPage(url)) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });

  // Right-clicks the page did not handle (text boxes, selected text): the page draws its own menu
  // for them (konusgac:native-menu), so they look like every other menu in the app.
  win.webContents.on('context-menu', (_event, p) => {
    if (!win || new URL(win.webContents.getURL()).origin !== APP_ORIGIN) return;
    win.webContents.send('konusgac:native-menu', {
      x: p.x,
      y: p.y,
      isEditable: p.isEditable,
      selectionText: p.selectionText,
      misspelledWord: p.misspelledWord,
      dictionarySuggestions: p.dictionarySuggestions ?? [],
      linkURL: /^https?:/.test(p.linkURL) ? p.linkURL : '',
      editFlags: p.editFlags,
    });
  });

  // The server could not be reached (offline, DNS) or answered with an error page: "Tekrar dene".
  win.webContents.on('did-fail-load', (_event, code, _desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && url.startsWith(APP_ORIGIN)) void win.loadURL(connectPage({ ulasilamadi: APP_ORIGIN }));
  });
  win.webContents.on('did-navigate', (_event, url, status) => {
    if (status >= 500 && url.startsWith(APP_ORIGIN)) void win.loadURL(connectPage({ ulasilamadi: APP_ORIGIN }));
  });

  win.on('focus', () => win.flashFrame(false));
  win.on('closed', () => (win = null));
  // With "minimize to tray", the close button hides the window; quitting is in the tray menu.
  win.on('close', (event) => {
    if (!quitting && windowSettings().minimizeToTray && tray) {
      event.preventDefault();
      win.hide();
    }
  });
  void win.loadURL(startUrl);
  const startHidden = windowSettings().startMinimized && process.argv.includes('--baslangic');
  if (startHidden) win.once('ready-to-show', () => win.hide());
  createTray();
}

function createTray() {
  if (tray) return;
  tray = new Tray(path.join(__dirname, 'icon.ico'));
  tray.setToolTip('Konuşgaç');
  tray.on('click', showWindow);
  tray.on('right-click', showTrayMenu);
}

// ---------- tray menu ----------
// Drawn by a small borderless window (tray-menu.html) so it looks like the app's own menus.

let trayMenu = null;
let trayState = { muted: false, deafened: false }; // reported by the app

function trayMenuWindow() {
  if (trayMenu && !trayMenu.isDestroyed()) return trayMenu;
  trayMenu = new BrowserWindow({
    width: 260,
    height: 300,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'tray-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  trayMenu.on('blur', () => trayMenu?.hide());
  void trayMenu.loadFile(path.join(__dirname, 'tray-menu.html'));
  return trayMenu;
}

function showTrayMenu() {
  const menu = trayMenuWindow();
  const send = () => menu.webContents.send('konusgac:tray-state', { ...trayState, canUpdate: !!updater });
  // The page answers with its size (konusgac:tray-size); the window is placed and shown then.
  if (menu.webContents.isLoading()) menu.webContents.once('did-finish-load', send);
  else send();
}

ipcMain.on('konusgac:tray-size', (event, width, height) => {
  if (!trayMenu || event.sender !== trayMenu.webContents) return;
  const w = Math.min(Math.max(width, 200), 400);
  const h = Math.min(Math.max(height, 100), 600);
  // Next to the pointer, kept inside the screen (above it when the taskbar is at the bottom).
  const p = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(p).workArea;
  const x = Math.min(Math.max(p.x - 8, area.x), area.x + area.width - w);
  const y = p.y + h > area.y + area.height ? Math.max(area.y, p.y - h + 8) : p.y - 8;
  trayMenu.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h });
  trayMenu.show();
  trayMenu.focus();
});

ipcMain.on('konusgac:tray-action', async (event, action) => {
  if (!trayMenu || event.sender !== trayMenu.webContents) return;
  trayMenu.hide();
  if (action === 'open') showWindow();
  else if (action === 'mute') win?.webContents.send('konusgac:shortcut', 'toggleMute');
  else if (action === 'deafen') win?.webContents.send('konusgac:shortcut', 'toggleDeaf');
  else if (action === 'update' && updater) {
    const result = await updater.checkForUpdates().catch(() => null);
    const newer = result?.updateInfo && result.updateInfo.version !== app.getVersion();
    if (!newer) {
      void dialog.showMessageBox({ type: 'info', title: 'Konuşgaç', message: `Konuşgaç güncel (${app.getVersion()}).` });
    } // a newer one downloads and then asks to restart (startUpdates)
  } else if (action === 'quit') {
    quitting = true;
    app.quit();
  }
});

// The app tells the tray menu whether the microphone and sound are off.
ipcMain.on('konusgac:tray-state', (event, state) => {
  if (!fromApp(event) || typeof state !== 'object' || !state) return;
  trayState = { muted: state.muted === true, deafened: state.deafened === true };
});

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

app.on('before-quit', () => (quitting = true));

function applyLoginItem() {
  const s = windowSettings();
  // Only the installed app registers itself; a development copy would start the wrong program.
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: s.openAtLogin, args: ['--baslangic'] });
}

// IPC from the app's own top-level frame (the server's web client, or the bundled connect page).
function fromFrame(event, allowed) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return false;
  return allowed.some((a) => (a === CONNECT_PAGE ? isConnectPage(frame.url) : new URL(frame.url).origin === a));
}
function isConnectPage(url) {
  return url.split(/[?#]/)[0] === CONNECT_PAGE;
}
const fromApp = (event) => !!APP_ORIGIN && fromFrame(event, [APP_ORIGIN]);

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

ipcMain.on('konusgac:notify', (event, title, body) => {
  if (!fromApp(event) || !Notification.isSupported()) return;
  const n = new Notification({ title: str(title, 100), body: str(body, 300) });
  n.on('click', () => {
    win?.show();
    win?.focus();
  });
  n.show();
});

ipcMain.on('konusgac:set-badge', (event, count, flash) => {
  if (!fromApp(event) || !win) return;
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  app.setBadgeCount(n); // macOS / Linux docks
  if (n > 0 && flash !== false && !win.isFocused()) win.flashFrame(true); // Windows taskbar
});

// The connect page asks to use a server: check that Konuşgaç answers there, save it, restart.
ipcMain.handle('konusgac:set-server', async (event, raw) => {
  if (!fromFrame(event, [CONNECT_PAGE])) return { ok: false, error: 'İzin verilmeyen istek' };
  let url;
  try {
    const text = str(raw, 300).trim();
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
  } catch {
    return { ok: false, error: 'Geçerli bir adres yaz, örnek: https://konusgac.ornek.org' };
  }
  if (!(await serverUp(url.origin))) return { ok: false, error: `${url.origin} adresinde Konuşgaç sunucusu bulunamadı.` };
  writeSettings({ serverUrl: url.origin });
  app.relaunch();
  app.exit(0);
  return { ok: true };
});

// From the web client's settings: show the "another server" page; nothing changes until one is picked.
ipcMain.on('konusgac:change-server', (event) => {
  if (!fromApp(event) || LOCAL || process.env.KONUSGAC_URL) return;
  void win?.loadURL(connectPage());
});

// From the connect page: try the current server again (also "Vazgeç").
ipcMain.on('konusgac:retry', async (event) => {
  if (!fromFrame(event, [CONNECT_PAGE]) || !win) return;
  void win.loadURL((await serverUp(APP_ORIGIN)) ? APP_URL : connectPage({ ulasilamadi: APP_ORIGIN }));
});

// From the connect page: back to Konuşgaç's own server.
ipcMain.on('konusgac:use-default-server', (event) => {
  if (!fromFrame(event, [CONNECT_PAGE])) return;
  writeSettings({ serverUrl: null });
  app.relaunch();
  app.exit(0);
});

let pickedSource = null;

ipcMain.handle('konusgac:screen-sources', async (event) => {
  if (!fromApp(event)) return [];
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
  return sources
    .filter((s) => !s.thumbnail.isEmpty())
    .map((s) => ({ id: s.id, name: s.name, screen: s.id.startsWith('screen:'), thumbnail: s.thumbnail.toDataURL() }));
});

ipcMain.handle('konusgac:pick-screen-source', (event, id, audio) => {
  if (!fromApp(event)) return false;
  pickedSource = { id: str(id, 200), audio: audio === true };
  return true;
});

ipcMain.on('konusgac:native-menu-action', (event, action, arg) => {
  if (!fromApp(event)) return;
  const wc = event.sender;
  if (action === 'cut') wc.cut();
  else if (action === 'copy') wc.copy();
  else if (action === 'paste') wc.paste();
  else if (action === 'selectAll') wc.selectAll();
  else if (action === 'undo') wc.undo();
  else if (action === 'redo') wc.redo();
  else if (action === 'replace' && arg) wc.replaceMisspelling(str(arg, 100));
  else if (action === 'learn' && arg) wc.session.addWordToSpellCheckerDictionary(str(arg, 100));
  else if (action === 'copyLink' && arg) clipboard.writeText(str(arg, 2000));
});

// "Google ile devam et": Google refuses sign-in inside apps, so it opens in the system browser.
ipcMain.on('konusgac:google-sign-in', (event) => {
  if (!fromApp(event)) return;
  void shell.openExternal(`${APP_ORIGIN}/api/auth/google?app=1`);
});

ipcMain.handle('konusgac:info', (event) => {
  if (!fromApp(event) && !fromFrame(event, [CONNECT_PAGE])) return null;
  return { version: app.getVersion(), canChangeServer: !LOCAL && !process.env.KONUSGAC_URL, server: APP_ORIGIN };
});

ipcMain.handle('konusgac:get-window-settings', (event) => (fromApp(event) ? windowSettings() : null));

ipcMain.on('konusgac:set-window-settings', (event, patch) => {
  if (!fromApp(event) || typeof patch !== 'object' || !patch) return;
  const next = { ...windowSettings() };
  for (const key of Object.keys(WINDOW_DEFAULTS)) if (typeof patch[key] === 'boolean') next[key] = patch[key];
  writeSettings({ window: next });
  applyLoginItem();
});

ipcMain.on('konusgac:set-zoom', (event, factor) => {
  if (!fromApp(event) || typeof factor !== 'number') return;
  event.sender.setZoomFactor(Math.min(2, Math.max(0.5, factor)));
});

// System-wide mute / deafen toggles: Electron accelerators chosen on the keybinds page.
ipcMain.on('konusgac:set-shortcuts', (event, keys) => {
  if (!fromApp(event) || typeof keys !== 'object' || !keys) return;
  globalShortcut.unregisterAll();
  for (const name of ['toggleMute', 'toggleDeaf']) {
    const accel = typeof keys[name] === 'string' ? keys[name].slice(0, 60) : null;
    if (!accel) continue;
    try {
      globalShortcut.register(accel, () => win?.webContents.send('konusgac:shortcut', name));
    } catch {
      // not a valid accelerator on this system; the in-window keybind still works
    }
  }
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!win) createWindow();
});
