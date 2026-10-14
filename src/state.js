const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = 'app-state.json';

function stateFile(name) {
  return path.join(app.getPath('userData'), name);
}

function loadState(name = DEFAULT_FILE) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(name), 'utf8'));
    return state && typeof state === 'object' ? state : {};
  } catch {
    return {};
  }
}

// Write-then-rename so a crash mid-write can't leave a truncated file. Only
// the user can read it: the push state holds private keys.
function saveState(state, name = DEFAULT_FILE) {
  const target = stateFile(name);
  const tmp = `${target}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (err) {
    console.error('Failed to save app state:', err);
  }
}

module.exports = { loadState, saveState };
