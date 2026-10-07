const { Menu, clipboard, shell } = require('electron');

function trimSeparators(items) {
  const out = [];
  for (const item of items) {
    if (item.type === 'separator' && (out.length === 0 || out[out.length - 1].type === 'separator')) continue;
    out.push(item);
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop();
  return out;
}

function buildContextMenu(wc, params, { openInNewTab, isAsanaUrl }) {
  const items = [];
  const separator = { type: 'separator' };

  if (params.misspelledWord) {
    const suggestions = params.dictionarySuggestions.slice(0, 5);
    for (const word of suggestions) {
      items.push({ label: word, click: () => wc.replaceMisspelling(word) });
    }
    if (suggestions.length === 0) items.push({ label: 'No Suggestions', enabled: false });
    items.push({
      label: 'Add to Dictionary',
      click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord),
    });
    items.push(separator);
  }

  if (/^(https?|mailto):/.test(params.linkURL)) {
    if (isAsanaUrl(params.linkURL)) {
      items.push({ label: 'Open Link in New Tab', click: () => openInNewTab(params.linkURL) });
    }
    items.push({ label: 'Open Link in Browser', click: () => shell.openExternal(params.linkURL) });
    items.push({ label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) });
    items.push(separator);
  }

  if (params.mediaType === 'image' && params.hasImageContents) {
    items.push({ label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) });
    items.push(separator);
  }

  if (params.isEditable) {
    const f = params.editFlags;
    items.push(
      { label: 'Undo', accelerator: 'Ctrl+Z', enabled: f.canUndo, click: () => wc.undo() },
      { label: 'Redo', accelerator: 'Ctrl+Shift+Z', enabled: f.canRedo, click: () => wc.redo() },
      separator,
      { label: 'Cut', accelerator: 'Ctrl+X', enabled: f.canCut, click: () => wc.cut() },
      { label: 'Copy', accelerator: 'Ctrl+C', enabled: f.canCopy, click: () => wc.copy() },
      { label: 'Paste', accelerator: 'Ctrl+V', enabled: f.canPaste, click: () => wc.paste() },
      {
        label: 'Paste as Plain Text',
        accelerator: 'Ctrl+Shift+V',
        enabled: f.canPaste,
        click: () => wc.pasteAndMatchStyle(),
      },
      separator,
      { label: 'Select All', accelerator: 'Ctrl+A', enabled: f.canSelectAll, click: () => wc.selectAll() },
    );
  } else if (params.selectionText.trim()) {
    items.push({ label: 'Copy', accelerator: 'Ctrl+C', click: () => wc.copy() });
  }

  if (trimSeparators(items).length === 0) {
    const history = wc.navigationHistory;
    items.push(
      { label: 'Back', accelerator: 'Alt+Left', enabled: history.canGoBack(), click: () => history.goBack() },
      { label: 'Forward', accelerator: 'Alt+Right', enabled: history.canGoForward(), click: () => history.goForward() },
      { label: 'Reload', accelerator: 'Ctrl+R', click: () => wc.reload() },
    );
  }

  return Menu.buildFromTemplate(trimSeparators(items));
}

module.exports = { buildContextMenu };
