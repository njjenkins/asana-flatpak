const api = window.headerAPI;
const tabsEl = document.getElementById('tabs');
const SVG_NS = 'http://www.w3.org/2000/svg';
const DRAG_THRESHOLD = 6;

const ICONS = {
  close: 'M5 5l6 6M11 5l-6 6',
  minimize: 'M4.5 11.5h7',
  maximize: 'M5.5 4.5h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z',
  restore:
    'M6.5 4.5h4a1 1 0 0 1 1 1v4M4.5 7.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1z',
};

const CONTROL_LABELS = { minimize: 'Minimize', maximize: 'Maximize', close: 'Close' };
const CONTROL_ACTIONS = { minimize: api.minimize, maximize: api.toggleMaximize, close: api.close };

function icon(pathData) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', pathData);
  svg.appendChild(path);
  return svg;
}

/* Window controls */

let maximizeIconPath = null;

function renderControls(container, names) {
  for (const name of names) {
    const button = document.createElement('button');
    button.title = CONTROL_LABELS[name];
    button.setAttribute('aria-label', CONTROL_LABELS[name]);
    button.addEventListener('click', CONTROL_ACTIONS[name]);

    const circle = document.createElement('span');
    circle.className = 'circle';
    const svg = icon(ICONS[name]);
    if (name === 'maximize') maximizeIconPath = svg.firstChild;
    circle.appendChild(svg);
    button.appendChild(circle);
    container.appendChild(button);
  }
}

/* Tabs: elements are kept per tab id and updated in place, so an update
   arriving mid-click or mid-drag never destroys the element under the pointer. */

const tabEls = new Map();
let activeId = null;
let drag = null;

function createTabEl(id) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.setAttribute('role', 'tab');
  el.dataset.id = id;

  const iconSlot = document.createElement('span');
  iconSlot.className = 'tab-icon-slot';

  const title = document.createElement('span');
  title.className = 'tab-title';

  const close = document.createElement('button');
  close.className = 'tab-close';
  close.title = 'Close Tab (Ctrl+W)';
  close.setAttribute('aria-label', 'Close Tab');
  close.appendChild(icon(ICONS.close));
  close.addEventListener('pointerdown', (event) => event.stopPropagation());
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    api.closeTab(id);
  });

  el.append(iconSlot, title, close);

  el.addEventListener('pointerdown', (event) => {
    if (event.button === 1) {
      event.preventDefault(); // suppress middle-click autoscroll
      return;
    }
    if (event.button !== 0) return;
    setActive(id);
    api.activateTab(id);
    startDrag(event, el, id);
  });
  el.addEventListener('pointermove', onDragMove);
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', cancelDrag);
  el.addEventListener('auxclick', (event) => {
    if (event.button === 1) api.closeTab(id);
  });

  const entry = { el, iconSlot, title, iconKey: null };
  tabEls.set(id, entry);
  return entry;
}

function updateIcon(entry, tab) {
  const key = tab.loading ? 'loading' : tab.favicon || '';
  if (key === entry.iconKey) return;
  entry.iconKey = key;
  entry.iconSlot.replaceChildren();
  if (tab.loading) {
    const spinner = document.createElement('span');
    spinner.className = 'tab-spinner';
    entry.iconSlot.appendChild(spinner);
  } else if (tab.favicon) {
    const img = document.createElement('img');
    img.className = 'tab-icon';
    img.src = tab.favicon;
    img.alt = '';
    img.draggable = false;
    img.addEventListener('error', () => img.remove());
    entry.iconSlot.appendChild(img);
  }
}

function setActive(id) {
  activeId = id;
  for (const [tabId, { el }] of tabEls) {
    const active = tabId === id;
    el.classList.toggle('active', active);
    el.setAttribute('aria-selected', String(active));
  }
}

function renderTabs({ tabs, activeTabId, theme }) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;

  const ids = tabs.map((t) => t.id);
  if (drag && ids.join() !== drag.ids.join()) cancelDrag();

  tabs.forEach((tab, index) => {
    const entry = tabEls.get(tab.id) ?? createTabEl(tab.id);
    entry.el.title = tab.title;
    if (entry.title.textContent !== tab.title) entry.title.textContent = tab.title;
    updateIcon(entry, tab);

    if (!drag) {
      const current = tabsEl.children[index];
      if (current !== entry.el) tabsEl.insertBefore(entry.el, current ?? null);
    }
  });

  for (const [id, entry] of tabEls) {
    if (!ids.includes(id)) {
      entry.el.remove();
      tabEls.delete(id);
    }
  }

  const activeChanged = activeTabId !== activeId;
  setActive(activeTabId);
  if (activeChanged && !drag) {
    tabEls.get(activeTabId)?.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

/* Drag to reorder */

function startDrag(event, el, id) {
  const els = [...tabsEl.children];
  const rects = els.map((e) => e.getBoundingClientRect());
  const index = els.indexOf(el);
  drag = {
    id,
    el,
    els,
    rects,
    ids: els.map((e) => Number(e.dataset.id)),
    startX: event.clientX,
    startIndex: index,
    targetIndex: index,
    step: rects.length > 1 ? rects[1].left - rects[0].left : rects[0].width,
    moving: false,
  };
  el.setPointerCapture(event.pointerId);
}

function onDragMove(event) {
  if (!drag || event.currentTarget !== drag.el) return;
  const dx = event.clientX - drag.startX;
  if (!drag.moving) {
    if (Math.abs(dx) < DRAG_THRESHOLD || drag.els.length < 2) return;
    drag.moving = true;
    drag.el.classList.add('dragging');
    tabsEl.classList.add('reordering');
  }

  const { rects, startIndex } = drag;
  const own = rects[startIndex];
  const offset = Math.max(rects[0].left - own.left, Math.min(rects[rects.length - 1].right - own.right, dx));
  drag.el.style.transform = `translateX(${offset}px)`;

  const target = Math.max(0, Math.min(rects.length - 1, startIndex + Math.round(offset / drag.step)));
  drag.targetIndex = target;

  drag.els.forEach((other, i) => {
    if (i === startIndex) return;
    let shift = 0;
    if (startIndex < target && i > startIndex && i <= target) shift = -drag.step;
    else if (startIndex > target && i >= target && i < startIndex) shift = drag.step;
    other.style.transform = shift ? `translateX(${shift}px)` : '';
  });
}

function resetDragStyles(els) {
  tabsEl.classList.add('no-anim');
  for (const el of els) el.style.transform = '';
  drag?.el.classList.remove('dragging');
  tabsEl.classList.remove('reordering');
  void tabsEl.offsetWidth; // flush styles before re-enabling transitions
  tabsEl.classList.remove('no-anim');
}

function endDrag() {
  if (!drag) return;
  const { id, el, els, moving, startIndex, targetIndex } = drag;
  if (moving && targetIndex !== startIndex) {
    const rest = els.filter((e) => e !== el);
    tabsEl.insertBefore(el, rest[targetIndex] ?? null);
    api.moveTab(id, targetIndex);
  }
  resetDragStyles(els);
  drag = null;
}

function cancelDrag() {
  if (!drag) return;
  resetDragStyles(drag.els);
  drag = null;
}

tabsEl.addEventListener(
  'wheel',
  (event) => {
    if (event.deltaY === 0 || drag) return;
    tabsEl.scrollLeft += event.deltaY;
    event.preventDefault();
  },
  { passive: false },
);

document.getElementById('new-tab').addEventListener('click', api.newTab);

api.getButtonLayout().then(({ left, right }) => {
  renderControls(document.getElementById('controls-start'), left);
  renderControls(document.getElementById('controls-end'), right);
});

api.onTabsUpdated(renderTabs);

api.onWindowState(({ focused, maximized, fullscreen }) => {
  document.body.classList.toggle('backdrop', !focused);
  document.body.classList.toggle('fullscreen', fullscreen);
  if (maximizeIconPath) {
    maximizeIconPath.setAttribute('d', maximized ? ICONS.restore : ICONS.maximize);
    maximizeIconPath.closest('button').title = maximized ? 'Restore' : 'Maximize';
  }
});
