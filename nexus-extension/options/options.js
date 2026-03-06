// nexus-extension/options/options.js
// Handles loading and saving extension settings.

'use strict';

const DEFAULTS = {
  port:             6543,
  alwaysIntercept:  false,
  showVideoButtons: true,
  autoPlaylist:     true,
  saveDir:          '',
  notifyAdded:      true,
  notifyCompleted:  true,
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const portInput       = document.getElementById('port');
const alwaysIntercept = document.getElementById('alwaysIntercept');
const showVideoButtons = document.getElementById('showVideoButtons');
const autoPlaylist    = document.getElementById('autoPlaylist');
const saveDirInput    = document.getElementById('saveDir');
const notifyAdded     = document.getElementById('notifyAdded');
const notifyCompleted = document.getElementById('notifyCompleted');
const saveBtn         = document.getElementById('save-btn');
const resetBtn        = document.getElementById('reset-btn');
const toast           = document.getElementById('toast');

// ─── Load settings ────────────────────────────────────────────────────────────

function applyToUI(settings) {
  portInput.value          = settings.port            ?? DEFAULTS.port;
  alwaysIntercept.checked  = settings.alwaysIntercept ?? DEFAULTS.alwaysIntercept;
  showVideoButtons.checked = settings.showVideoButtons ?? DEFAULTS.showVideoButtons;
  autoPlaylist.checked     = settings.autoPlaylist     ?? DEFAULTS.autoPlaylist;
  saveDirInput.value       = settings.saveDir         ?? DEFAULTS.saveDir;
  notifyAdded.checked      = settings.notifyAdded     ?? DEFAULTS.notifyAdded;
  notifyCompleted.checked  = settings.notifyCompleted ?? DEFAULTS.notifyCompleted;
}

chrome.storage.sync.get(Object.keys(DEFAULTS), (data) => {
  applyToUI({ ...DEFAULTS, ...data });
});

// ─── Save settings ────────────────────────────────────────────────────────────

saveBtn.addEventListener('click', () => {
  const portValue = parseInt(portInput.value, 10);
  if (!Number.isInteger(portValue) || portValue < 1024 || portValue > 65535) {
    portInput.style.borderColor = 'var(--error)';
    portInput.focus();
    return;
  }
  portInput.style.borderColor = '';

  const settings = {
    port:             portValue,
    alwaysIntercept:  alwaysIntercept.checked,
    showVideoButtons: showVideoButtons.checked,
    autoPlaylist:     autoPlaylist.checked,
    saveDir:          saveDirInput.value.trim(),
    notifyAdded:      notifyAdded.checked,
    notifyCompleted:  notifyCompleted.checked,
  };

  chrome.storage.sync.set(settings, () => {
    if (chrome.runtime.lastError) {
      showToast('⚠ Save failed: ' + chrome.runtime.lastError.message, true);
    } else {
      showToast('✔ Settings saved');
    }
  });
});

// ─── Reset to defaults ────────────────────────────────────────────────────────

resetBtn.addEventListener('click', () => {
  applyToUI(DEFAULTS);
  chrome.storage.sync.set(DEFAULTS, () => {
    if (chrome.runtime.lastError) {
      showToast('⚠ Reset failed: ' + chrome.runtime.lastError.message, true);
    } else {
      showToast('✔ Reset to defaults');
    }
  });
});

// ─── Toast helper ─────────────────────────────────────────────────────────────

let toastTimer = null;

function showToast(msg, isError = false) {
  toast.textContent = msg;
  toast.style.background = isError ? 'var(--error)' : 'var(--success)';
  toast.classList.add('visible');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2500);
}
