// nexus-extension/content/content.js
// Entry point for content scripts – sets up the message bus and delegates
// to site-specific modules and shared UI components.

(function () {
  'use strict';

  // Prevent double-injection
  if (window.__nexusInjected) return;
  window.__nexusInjected = true;

  // ── State ─────────────────────────────────────────────────────────────────

  const state = {
    detectedVideos: [],
    isOverlay: false,
  };

  // ── Message listener ──────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case 'DOWNLOAD_DETECTED':
        handleDetectedDownload(msg);
        sendResponse({ ok: true });
        break;
      case 'PING':
        sendResponse({ ok: true, injected: true });
        break;
      default:
        break;
    }
  });

  // ── Detected download notification ────────────────────────────────────────

  function handleDetectedDownload(info) {
    // Ask user if they want to download with Nexus
    if (document.hidden) return; // Don't show in background tabs

    const existing = document.getElementById('__nexus-intercept-bar');
    if (existing) existing.remove();

    const bar = document.createElement('div');
    bar.id = '__nexus-intercept-bar';
    bar.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
      background: #1a1a35; border-bottom: 2px solid #6c63ff;
      color: #e8e8f0; font: 13px/1 -apple-system,sans-serif;
      display: flex; align-items: center; gap: 12px; padding: 8px 16px;
      box-shadow: 0 2px 12px rgba(0,0,0,.5);
    `;

    const text = document.createElement('span');
    text.textContent = `⬇ Download detected: ${truncate(info.url, 60)}`;
    text.style.flex = '1';

    const btnDownload = makeButton('Download with Nexus', '#6c63ff', () => {
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_URL', url: info.url });
      bar.remove();
    });

    const btnDismiss = makeButton('Dismiss', '#555', () => bar.remove());

    bar.append(text, btnDownload, btnDismiss);
    document.body.prepend(bar);

    // Auto-dismiss after 8 seconds
    setTimeout(() => bar?.remove(), 8000);
  }

  function makeButton(label, bg, onClick) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.style.cssText = `
      padding: 4px 12px; border-radius: 5px; border: none;
      background: ${bg}; color: #fff; font: 12px/1 -apple-system,sans-serif;
      cursor: pointer; white-space: nowrap;
    `;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function truncate(str, n) {
    return str.length > n ? str.slice(0, n) + '…' : str;
  }

  // Export state so site modules can read/write it
  window.__nexusState = state;
})();
