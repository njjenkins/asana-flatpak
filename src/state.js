const { app } = require('electron');
const fs = require('fs');
const path = require('path');

function stateFile() {
  return path.join(app.getPath('userData'), 'app-state.json');
}

function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    return state && typeof state === 'object' ? state : {};
  } catch {
    return {};
  }
}

// Write-then-rename so a crash mid-write can't leave a truncated file.
function saveState(state) {
  const target = stateFile();
  const tmp = `${target}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, target);
  } catch (err) {
    console.error('Failed to save app state:', err);
  }
}

module.exports = { loadState, saveState };
