// nexus-extension/popup/popup.js
// Controls the popup UI.

'use strict';

const NEXUS_PORT = 6543;
const BASE_URL   = `http://127.0.0.1:${NEXUS_PORT}`;

// ─── State ────────────────────────────────────────────────────────────────────

let downloads = [];
let activeTab = 'active';
let nexusOnline = false;

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const statusDot  = document.getElementById('status-dot');
const urlInput   = document.getElementById('url-input');
const addBtn     = document.getElementById('add-btn');
const dlList     = document.getElementById('dl-list');
const emptyMsg   = document.getElementById('empty-msg');
const openAppBtn = document.getElementById('open-app-btn');
const settingsBtn = document.getElementById('settings-btn');
const tabs       = document.querySelectorAll('.tab');

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await checkStatus();
  if (nexusOnline) {
    await loadDownloads();
  }

  // Try to prefill URL from current tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab) return;
    const url = tab.url || '';
    if (!url.startsWith('http')) return;
    urlInput.placeholder = 'Paste URL or leave blank to use current page';
    urlInput.dataset.currentUrl = url;
  });
}

// ─── Status check ─────────────────────────────────────────────────────────────

async function checkStatus() {
  try {
    const res = await fetchJSON('/health');
    nexusOnline = !!res.status;
  } catch (_) {
    nexusOnline = false;
  }
  statusDot.className = `status-dot ${nexusOnline ? 'online' : 'offline'}`;
  statusDot.title = nexusOnline ? `Nexus running (v${await getVersion()})` : 'Nexus not running';
}

async function getVersion() {
  try { const r = await fetchJSON('/health'); return r.version || '?'; } catch (_) { return '?'; }
}

// ─── Load downloads ───────────────────────────────────────────────────────────

async function loadDownloads() {
  try {
    downloads = await fetchJSON('/downloads');
    renderDownloads();
  } catch (_) {
    downloads = [];
    renderDownloads();
  }
}

function renderDownloads() {
  const filtered = filterDownloads(downloads, activeTab);
  dlList.innerHTML = '';

  if (filtered.length === 0) {
    const msg = document.createElement('div');
    msg.className = 'empty-msg';
    msg.textContent = nexusOnline ? 'No downloads' : '⚠ Nexus app is not running';
    dlList.appendChild(msg);
    return;
  }

  filtered.forEach((dl) => {
    const item = createDownloadItem(dl);
    dlList.appendChild(item);
  });
}

function filterDownloads(dls, tab) {
  if (tab === 'active')    return dls.filter((d) => ['downloading', 'queued', 'merging', 'paused'].includes(d.status));
  if (tab === 'completed') return dls.filter((d) => d.status === 'completed');
  return dls;
}

function createDownloadItem(dl) {
  const item = document.createElement('div');
  item.className = 'dl-item';

  const statusColors = { downloading: '#6c63ff', completed: '#4ade80', paused: '#facc15', error: '#f87171', queued: '#9090b0' };
  const statusColor = statusColors[dl.status] || '#9090b0';
  const progress = Math.min(100, dl.progress || 0);

  item.innerHTML = `
    <div class="dl-item-top">
      <span class="dl-title" title="${escHtml(dl.title || dl.url || '')}">${escHtml(dl.title || dl.filename || 'Download')}</span>
      <span class="dl-status" style="color:${statusColor}">${dl.status.toUpperCase()}</span>
    </div>
    ${dl.status !== 'completed' && dl.status !== 'error'
      ? `<div class="progress-bar"><div class="progress-fill" style="width:${progress}%"></div></div>`
      : ''}
    <div class="dl-meta">
      ${formatBytes(dl.downloaded)} / ${formatBytes(dl.file_size)}
      ${dl.speed > 0 ? ` · ${formatBytes(dl.speed)}/s` : ''}
    </div>
  `;

  return item;
}

// ─── Add download ─────────────────────────────────────────────────────────────

addBtn.addEventListener('click', async () => {
  let url = urlInput.value.trim();
  if (!url) url = urlInput.dataset.currentUrl || '';
  if (!url) { flash(addBtn, '⚠ No URL'); return; }

  try { new URL(url); } catch (_) { flash(addBtn, '⚠ Invalid URL'); return; }

  if (!nexusOnline) { flash(addBtn, '⚠ Nexus not running'); return; }

  addBtn.textContent = 'Adding…';
  addBtn.disabled = true;

  try {
    await postJSON('/downloads', { url });
    urlInput.value = '';
    flash(addBtn, '✔ Added!');
    await loadDownloads();
  } catch (err) {
    flash(addBtn, '✕ Error');
  } finally {
    setTimeout(() => { addBtn.textContent = '⬇ Add'; addBtn.disabled = false; }, 1500);
  }
});

urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click(); });

// ─── Tabs ─────────────────────────────────────────────────────────────────────

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    activeTab = tab.dataset.tab;
    renderDownloads();
  });
});

// ─── Footer buttons ───────────────────────────────────────────────────────────

openAppBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'OPEN_APP' }).catch(() => {});
  window.close();
});

settingsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage?.();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchJSON(path) {
  const res = await fetch(`${BASE_URL}${path}`, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function postJSON(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function formatBytes(b) {
  if (!b) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return `${(b / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function flash(btn, msg) {
  const orig = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => { btn.textContent = orig; }, 1500);
}

// ─── Start ────────────────────────────────────────────────────────────────────

init();

// Auto-refresh every 2 seconds while popup is open
setInterval(async () => {
  if (nexusOnline) await loadDownloads();
}, 2000);
