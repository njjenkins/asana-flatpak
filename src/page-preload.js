// Runs in an isolated world inside each Asana tab. Reports whether the page is
// currently rendering light or dark so the header bar can match Asana's own
// theme setting, which may differ from the system one, and relays
// notification clicks so the app can bring the right tab forward.
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
