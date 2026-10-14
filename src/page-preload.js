// Runs in an isolated world inside each Asana tab. Reports whether the page is
// currently rendering light or dark so the header bar can match Asana's own
// theme setting, which may differ from the system one, relays notification
// clicks so the app can bring the right tab forward, and provides Web Push.
const { contextBridge, ipcRenderer } = require('electron');

const NOTIFICATION_CLICK = 'asana-flatpak:notification-click';

// The page's Notification lives in the main world, so wrap it there.
contextBridge.executeInMainWorld({
  func: (message) => {
    const Native = window.Notification;
    if (!Native) return;
    class Notification extends Native {
      constructor(title, options) {
        super(title, options);
        this.addEventListener('click', () => window.postMessage(message, location.origin));
      }
    }
    Object.defineProperty(window, 'Notification', { value: Notification, writable: true, configurable: true });
  },
  args: [NOTIFICATION_CLICK],
});

window.addEventListener('message', (event) => {
  if (event.source === window && event.data === NOTIFICATION_CLICK) {
    ipcRenderer.send('notification-click');
  }
});

// Electron has no push service, so PushManager is replaced with one backed by
// the main process (src/push.js). Asana's service worker never sees these
// messages; the main process shows the notifications itself.
contextBridge.executeInMainWorld({
  func: (bridge) => {
    if (!window.PushManager || !window.PushSubscription) return;

    const toBase64Url = (bytes) =>
      btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const fromBase64Url = (text) =>
      Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)).buffer;
    const keyToString = (key) => {
      if (typeof key === 'string') return key.replace(/=+$/, '');
      if (key instanceof ArrayBuffer) return toBase64Url(new Uint8Array(key));
      if (ArrayBuffer.isView(key)) return toBase64Url(new Uint8Array(key.buffer, key.byteOffset, key.byteLength));
      throw new DOMException('The provided applicationServerKey is not valid.', 'InvalidAccessError');
    };

    const toSubscription = (sub) => {
      if (!sub) return null;
      const keys = { p256dh: sub.p256dh, auth: sub.auth };
      const json = { endpoint: sub.endpoint, expirationTime: null, keys };
      return Object.create(PushSubscription.prototype, {
        endpoint: { value: sub.endpoint, enumerable: true },
        expirationTime: { value: null, enumerable: true },
        options: {
          value: { userVisibleOnly: true, applicationServerKey: fromBase64Url(sub.applicationServerKey) },
          enumerable: true,
        },
        getKey: { value: (name) => (name in keys ? fromBase64Url(keys[name]) : null) },
        toJSON: { value: () => structuredClone(json) },
        unsubscribe: { value: () => bridge.unsubscribe() },
      });
    };

    const define = (name, value) =>
      Object.defineProperty(PushManager.prototype, name, { value, writable: true, configurable: true });

    define('subscribe', async function subscribe(options = {}) {
      if (Notification.permission !== 'granted') {
        throw new DOMException('Registration failed - permission denied', 'NotAllowedError');
      }
      if (options.applicationServerKey == null) {
        throw new DOMException('Registration failed - missing applicationServerKey', 'AbortError');
      }
      const key = keyToString(options.applicationServerKey);
      try {
        return toSubscription(await bridge.subscribe(key));
      } catch {
        throw new DOMException('Registration failed - push service error', 'AbortError');
      }
    });
    define('getSubscription', async function getSubscription() {
      return toSubscription(await bridge.getSubscription());
    });
    define('permissionState', async function permissionState() {
      return Notification.permission === 'default' ? 'prompt' : Notification.permission;
    });
  },
  args: [
    {
      subscribe: (key) => ipcRenderer.invoke('push-subscribe', key),
      getSubscription: () => ipcRenderer.invoke('push-get-subscription'),
      unsubscribe: () => ipcRenderer.invoke('push-unsubscribe'),
    },
  ],
});

const POLL_MS = 1500;
// Points as fractions of the viewport: main content, top bar, lower right.
// The sidebar is avoided because it can contrast with the rest of the page.
const SAMPLE_POINTS = [
  [0.65, 0.6],
  [0.5, 0.03],
  [0.85, 0.85],
];

let canvasCtx = null;
let lastReported = null;

function toRgba(cssColor) {
  canvasCtx ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  canvasCtx.clearRect(0, 0, 1, 1);
  canvasCtx.fillStyle = '#00000000';
  canvasCtx.fillStyle = cssColor;
  canvasCtx.fillRect(0, 0, 1, 1);
  return canvasCtx.getImageData(0, 0, 1, 1).data;
}

function canvasIsDark() {
  const scheme = getComputedStyle(document.documentElement).colorScheme;
  return scheme.includes('dark') && !scheme.includes('light');
}

function backgroundLuminanceAt(x, y) {
  for (const el of document.elementsFromPoint(x, y)) {
    const [r, g, b, a] = toRgba(getComputedStyle(el).backgroundColor);
    if (a >= 200) return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }
  return canvasIsDark() ? 0 : 1;
}

function detectTheme() {
  if (!document.body || innerWidth === 0 || innerHeight === 0) return null;
  let darkVotes = 0;
  for (const [fx, fy] of SAMPLE_POINTS) {
    if (backgroundLuminanceAt(innerWidth * fx, innerHeight * fy) < 0.5) darkVotes++;
  }
  return darkVotes * 2 > SAMPLE_POINTS.length ? 'dark' : 'light';
}

function report() {
  if (document.visibilityState !== 'visible') return;
  const theme = detectTheme();
  if (theme && theme !== lastReported) {
    lastReported = theme;
    ipcRenderer.send('page-theme', theme);
  }
}

window.addEventListener('DOMContentLoaded', report);
window.addEventListener('load', report);
document.addEventListener('visibilitychange', report);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => setTimeout(report, 300));
setInterval(report, POLL_MS);
