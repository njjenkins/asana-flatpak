const { app, BrowserWindow, WebContentsView, Menu, Notification, ipcMain, nativeTheme, screen, session, shell } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const { buildContextMenu } = require('./context-menu');
const { PushService } = require('./push');
const { loadState, saveState } = require('./state');

const HEADER_HEIGHT = 47;
const HOME_URL = 'https://app.asana.com';
const SESSION_PARTITION = 'persist:asana';
const FALLBACK_BUTTON_LAYOUT = ':minimize,maximize,close';
const LOGIN_HOSTS = ['accounts.google.com', 'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com'];
const DEFAULT_SIZE = { width: 1360, height: 880 };
const MIN_SIZE = { width: 760, height: 480 };
const SAVE_DELAY_MS = 500;

// Everything else (camera, microphone, location, MIDI, USB, ...) is denied.
const ALLOWED_PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write', 'fullscreen']);

app.setName('Asana');

let mainWindow = null;
const tabs = [];
let activeTabId = null;
let tabCounter = 0;
let lastNormalSize = null;
let persistenceEnabled = false;
let saveTimer = null;
let push = null;
// Electron drops click handlers on notifications that get garbage collected.
const shownNotifications = new Set();

function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isAsanaUrl(url) {
  const u = parseUrl(url);
  return !!u && u.protocol === 'https:' && (u.hostname === 'asana.com' || u.hostname.endsWith('.asana.com'));
}

function isLoginUrl(url) {
  const u = parseUrl(url);
  if (!u || u.protocol !== 'https:') return false;
  return LOGIN_HOSTS.includes(u.hostname) || u.hostname.endsWith('.okta.com') || u.hostname.endsWith('.onelogin.com');
}

function openExternal(url) {
  if (/^(https?|mailto):/.test(url)) shell.openExternal(url);
}

function configureSession() {
  const ses = session.fromPartition(SESSION_PARTITION);
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && isAsanaUrl(details.requestingUrl));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return ALLOWED_PERMISSIONS.has(permission) && isAsanaUrl(requestingOrigin);
  });
  ses.setDevicePermissionHandler(() => false);
}

function focusWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Mirrors the "push" and "notificationclick" handlers in Asana's service
// worker, which never run here because the messages arrive in this process.
function notificationTarget(origin, payload) {
  if (typeof payload.url === 'string' && payload.url) return new URL(payload.url, origin).href;
  const ids = [payload.current_domain_user_id, payload.inbox_item_id, payload.inbox_story_id];
  if (ids.some((id) => id === undefined || id === null)) return origin;
  return new URL(`/0/inbox/${ids.join('/')}`, origin).href;
}

function showPushNotification(origin, data) {
  let payload;
  try {
    payload = JSON.parse(data.toString('utf8'));
  } catch {
    return;
  }
  if (!payload || typeof payload.title !== 'string') return;
  const target = notificationTarget(origin, payload);
  const notification = new Notification({
    title: payload.title,
    body: typeof payload.body === 'string' ? payload.body : '',
  });
  const forget = () => shownNotifications.delete(notification);
  notification.on('click', () => {
    forget();
    if (!mainWindow || !isAsanaUrl(target)) return;
    focusWindow();
    createTab(target);
  });
  notification.on('close', forget);
  notification.on('failed', forget);
  shownNotifications.add(notification);
  notification.show();
}

// Push requests come from the top frame of an Asana tab, keyed by its origin.
function pushOrigin(event) {
  const origin = event.senderFrame?.origin;
  const fromTab = tabs.some((t) => t.view.webContents === event.sender);
  if (!fromTab || !push || !isAsanaUrl(origin)) throw new Error('Push is not available here');
  return origin;
}

function cleanTitle(title) {
  return title.replace(/\s+[-–·|]\s+Asana$/, '').trim() || 'Asana';
}

function readButtonLayout() {
  // The portal works both inside the flatpak sandbox and on the host.
  const args = [
    'call', '--session',
    '--dest', 'org.freedesktop.portal.Desktop',
    '--object-path', '/org/freedesktop/portal/desktop',
    '--method', 'org.freedesktop.portal.Settings.ReadOne',
    'org.gnome.desktop.wm.preferences', 'button-layout',
  ];
  return new Promise((resolve) => {
    execFile('gdbus', args, { timeout: 2000 }, (err, stdout) => {
      const match = !err && stdout.match(/'([^']*)'/);
      resolve(match ? match[1] : FALLBACK_BUTTON_LAYOUT);
    });
  });
}

function parseButtonLayout(layout) {
  const known = new Set(['minimize', 'maximize', 'close']);
  const [left = '', right = ''] = layout.split(':');
  const pick = (side) => side.split(',').map((s) => s.trim()).filter((s) => known.has(s));
  return { left: pick(left), right: pick(right) };
}

const buttonLayout = readButtonLayout().then(parseButtonLayout);

function activeTab() {
  return tabs.find((t) => t.id === activeTabId);
}

function sendToHeader(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function sendTabsUpdate() {
  const tab = activeTab();
  sendToHeader('tabs-updated', {
    activeTabId,
    theme: tab?.theme ?? null,
    tabs: tabs.map(({ id, title, favicon, loading }) => ({ id, title, favicon, loading })),
  });
  if (mainWindow) {
    mainWindow.setTitle(tab ? `${tab.title} - Asana` : 'Asana');
    mainWindow.setBackgroundColor(windowBackground());
  }
  scheduleSave();
}

function snapshotState() {
  // On Wayland, unmaximizing emits a resize with a transitional size and no
  // event for the final one, so read the live size whenever we can.
  if (!mainWindow.isMaximized() && !mainWindow.isFullScreen()) {
    const [width, height] = mainWindow.getContentSize();
    lastNormalSize = { width, height };
  }
  const saved = tabs
    .map((t) => ({ url: t.pendingUrl ?? t.url, title: t.title, active: t.id === activeTabId }))
    .filter((t) => isAsanaUrl(t.url));
  return {
    window: { ...lastNormalSize, maximized: mainWindow.isMaximized() },
    tabs: saved.map(({ url, title }) => ({ url, title })),
    activeIndex: Math.max(0, saved.findIndex((t) => t.active)),
  };
}

function scheduleSave() {
  if (!persistenceEnabled) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
}

function saveNow() {
  clearTimeout(saveTimer);
  if (persistenceEnabled && mainWindow && !mainWindow.isDestroyed()) saveState(snapshotState());
}

function sendWindowState() {
  if (!mainWindow) return;
  sendToHeader('window-state', {
    focused: mainWindow.isFocused(),
    maximized: mainWindow.isMaximized(),
    fullscreen: mainWindow.isFullScreen(),
  });
}

function layoutTabs() {
  if (!mainWindow) return;
  const [width, height] = mainWindow.getContentSize();
  const bounds = { x: 0, y: HEADER_HEIGHT, width, height: Math.max(0, height - HEADER_HEIGHT) };
  for (const tab of tabs) tab.view.setBounds(bounds);
}

function activateTab(id) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  activeTabId = id;
  for (const t of tabs) t.view.setVisible(t.id === id);
  layoutTabs();
  if (tab.pendingUrl) {
    tab.view.webContents.loadURL(tab.pendingUrl);
    tab.pendingUrl = null;
  }
  tab.view.webContents.focus();
  sendTabsUpdate();
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const [tab] = tabs.splice(idx, 1);
  mainWindow.contentView.removeChildView(tab.view);
  tab.view.webContents.close();

  if (tabs.length === 0) {
    createTab();
  } else if (activeTabId === id) {
    activateTab(tabs[Math.min(idx, tabs.length - 1)].id);
  } else {
    sendTabsUpdate();
  }
}

function moveTab(id, toIndex) {
  const from = tabs.findIndex((t) => t.id === id);
  if (from === -1 || !Number.isInteger(toIndex)) return;
  const to = Math.max(0, Math.min(tabs.length - 1, toIndex));
  if (from === to) return;
  const [tab] = tabs.splice(from, 1);
  tabs.splice(to, 0, tab);
  sendTabsUpdate();
}

function cycleTab(step) {
  if (tabs.length < 2) return;
  const idx = tabs.findIndex((t) => t.id === activeTabId);
  activateTab(tabs[(idx + step + tabs.length) % tabs.length].id);
}

function zoom(delta) {
  const wc = activeTab()?.view.webContents;
  if (wc) wc.setZoomLevel(delta === null ? 0 : wc.getZoomLevel() + delta);
}

// Shortcuts are handled per-webContents because a frameless window has no
// menu bar to hang accelerators on.
function handleShortcut(event, input) {
  if (input.type !== 'keyDown') return;
  const key = input.key.toLowerCase();
  const ctrl = input.control && !input.alt && !input.meta;
  const wc = activeTab()?.view.webContents;
  let action = null;

  if (ctrl && !input.shift && key === 't') action = () => createTab();
  else if (ctrl && !input.shift && key === 'w') action = () => activeTabId && closeTab(activeTabId);
  else if (ctrl && key === 'tab') action = () => cycleTab(input.shift ? -1 : 1);
  else if (ctrl && input.shift && (key === 'pagedown' || key === 'pageup')) {
    const step = key === 'pagedown' ? 1 : -1;
    action = () => moveTab(activeTabId, tabs.findIndex((t) => t.id === activeTabId) + step);
  } else if (ctrl && key === 'pagedown') action = () => cycleTab(1);
  else if (ctrl && key === 'pageup') action = () => cycleTab(-1);
  else if (ctrl && /^[1-9]$/.test(key)) {
    const n = Number(key);
    action = () => {
      const target = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
      if (target) activateTab(target.id);
    };
  } else if ((ctrl && key === 'r') || (key === 'f5' && !input.control)) action = () => wc?.reload();
  else if (input.alt && !input.control && key === 'arrowleft') action = () => wc?.navigationHistory.goBack();
  else if (input.alt && !input.control && key === 'arrowright') action = () => wc?.navigationHistory.goForward();
  else if (ctrl && (key === '=' || key === '+')) action = () => zoom(0.5);
  else if (ctrl && key === '-') action = () => zoom(-0.5);
  else if (ctrl && key === '0') action = () => zoom(null);
  else if (key === 'f11') action = () => mainWindow.setFullScreen(!mainWindow.isFullScreen());

  if (action) {
    event.preventDefault();
    action();
  }
}

// Lazy tabs keep their URL in pendingUrl and only load when first activated,
// so restoring many tabs at startup stays cheap.
function createTab(url = HOME_URL, { lazy = false, title = 'Asana', activate = true } = {}) {
  const id = ++tabCounter;
  const view = new WebContentsView({
    webPreferences: {
      partition: SESSION_PARTITION,
      preload: path.join(__dirname, 'page-preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  const tab = {
    id,
    view,
    url,
    title,
    favicon: null,
    loading: !lazy,
    theme: null,
    pendingUrl: lazy ? url : null,
  };
  tabs.push(tab);
  mainWindow.contentView.addChildView(view);
  view.setVisible(false);

  const { webContents } = view;
  webContents.on('before-input-event', handleShortcut);
  webContents.on('context-menu', (_event, params) => {
    buildContextMenu(webContents, params, { openInNewTab: (link) => createTab(link), isAsanaUrl }).popup({
      window: mainWindow,
    });
  });

  webContents.on('page-title-updated', (_event, title) => {
    tab.title = cleanTitle(title);
    sendTabsUpdate();
  });
  webContents.on('page-favicon-updated', (_event, favicons) => {
    tab.favicon = favicons.find((f) => f.startsWith('https:')) ?? null;
    sendTabsUpdate();
  });
  webContents.on('did-navigate', (_event, navUrl) => {
    tab.url = navUrl;
    tab.favicon = null;
    scheduleSave();
  });
  // Asana is a single-page app, so most moves between pages are in-page.
  webContents.on('did-navigate-in-page', (_event, navUrl, isMainFrame) => {
    if (!isMainFrame) return;
    tab.url = navUrl;
    scheduleSave();
  });
  webContents.on('did-start-loading', () => {
    tab.loading = true;
    sendTabsUpdate();
  });
  webContents.on('did-stop-loading', () => {
    tab.loading = false;
    sendTabsUpdate();
  });

  // Asana links open in a new tab; anything else goes to the system browser.
  webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (isAsanaUrl(targetUrl)) createTab(targetUrl);
    else openExternal(targetUrl);
    return { action: 'deny' };
  });

  // SSO providers stay in-tab so login completes; other off-site links don't.
  webContents.on('will-navigate', (event, targetUrl) => {
    if (isAsanaUrl(targetUrl) || isLoginUrl(targetUrl)) return;
    event.preventDefault();
    openExternal(targetUrl);
  });

  if (!lazy) webContents.loadURL(url);
  layoutTabs();
  if (activate) activateTab(id);
  else sendTabsUpdate();
  return tab;
}

function restoreTabs(state) {
  const saved = Array.isArray(state.tabs)
    ? state.tabs.filter((t) => t && typeof t.url === 'string' && isAsanaUrl(t.url))
    : [];
  if (saved.length === 0) {
    createTab();
    return;
  }
  for (const t of saved) {
    const title = typeof t.title === 'string' && t.title ? t.title : 'Asana';
    createTab(t.url, { lazy: true, title, activate: false });
  }
  const index = Number.isInteger(state.activeIndex) ? state.activeIndex : 0;
  activateTab(tabs[Math.max(0, Math.min(tabs.length - 1, index))].id);
}

function initialWindowSize(state) {
  const { workAreaSize } = screen.getPrimaryDisplay();
  const clamp = (value, fallback, min, max) =>
    Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : Math.min(fallback, max);
  return {
    width: clamp(state.window?.width, DEFAULT_SIZE.width, MIN_SIZE.width, workAreaSize.width),
    height: clamp(state.window?.height, DEFAULT_SIZE.height, MIN_SIZE.height, workAreaSize.height),
  };
}

function windowBackground() {
  const theme = activeTab()?.theme;
  const dark = theme ? theme === 'dark' : nativeTheme.shouldUseDarkColors;
  return dark ? '#222226' : '#fafafb';
}

function createWindow() {
  const state = loadState();
  const size = initialWindowSize(state);
  lastNormalSize = size;

  mainWindow = new BrowserWindow({
    ...size,
    // Content size round-trips exactly; outer bounds can include CSD shadow insets.
    useContentSize: true,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    title: 'Asana',
    frame: false,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: path.join(__dirname, 'headerbar-preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  const header = mainWindow.webContents;
  header.on('before-input-event', handleShortcut);
  header.on('will-navigate', (event) => event.preventDefault());
  header.once('did-finish-load', () => {
    sendWindowState();
    restoreTabs(state);
    persistenceEnabled = true;
    saveNow();
  });

  mainWindow.once('ready-to-show', () => {
    // maximize() also shows the window.
    if (state.window?.maximized === true) mainWindow.maximize();
    else mainWindow.show();
  });

  mainWindow.on('page-title-updated', (event) => event.preventDefault());
  mainWindow.on('resize', () => {
    layoutTabs();
    if (!mainWindow.isMaximized() && !mainWindow.isFullScreen()) {
      const [width, height] = mainWindow.getContentSize();
      lastNormalSize = { width, height };
    }
    scheduleSave();
  });
  for (const evt of ['focus', 'blur', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    mainWindow.on(evt, sendWindowState);
  }
  mainWindow.on('maximize', scheduleSave);
  mainWindow.on('unmaximize', scheduleSave);
  mainWindow.on('close', () => {
    saveNow();
    persistenceEnabled = false;
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(__dirname, 'headerbar', 'index.html'));
}

nativeTheme.on('updated', () => {
  if (mainWindow) mainWindow.setBackgroundColor(windowBackground());
});

ipcMain.on('tab-new', () => createTab());
ipcMain.on('tab-activate', (_event, id) => activateTab(id));
ipcMain.on('tab-close', (_event, id) => closeTab(id));
ipcMain.on('tab-move', (_event, id, toIndex) => moveTab(id, toIndex));
ipcMain.on('page-theme', (event, theme) => {
  if (theme !== 'dark' && theme !== 'light') return;
  const tab = tabs.find((t) => t.view.webContents === event.sender);
  if (!tab || tab.theme === theme) return;
  tab.theme = theme;
  if (tab.id === activeTabId) sendTabsUpdate();
});
ipcMain.on('notification-click', (event) => {
  const tab = tabs.find((t) => t.view.webContents === event.sender);
  if (!tab || !mainWindow) return;
  focusWindow();
  activateTab(tab.id);
});
ipcMain.handle('push-subscribe', (event, applicationServerKey) => {
  const origin = pushOrigin(event);
  if (typeof applicationServerKey !== 'string' || !/^[A-Za-z0-9_-]+$/.test(applicationServerKey)) {
    throw new Error('Invalid applicationServerKey');
  }
  return push.subscribe(origin, applicationServerKey);
});
ipcMain.handle('push-get-subscription', (event) => push.getSubscription(pushOrigin(event)));
ipcMain.handle('push-unsubscribe', (event) => push.unsubscribe(pushOrigin(event)));
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-toggle-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window-close', () => mainWindow?.close());
ipcMain.handle('get-button-layout', () => buttonLayout);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    configureSession();
    push = new PushService(showPushNotification);
    push.start();
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
