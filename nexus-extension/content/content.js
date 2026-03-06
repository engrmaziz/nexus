// nexus-extension/content/content.js
// Master injector: initializes all Nexus content-script components and
// sets up the runtime message bus.

(function () {
  'use strict';

  // Prevent double-injection across dynamic module reloads
  if (window.__nexusInjected) return;
  window.__nexusInjected = true;

  // ── Shared state ────────────────────────────────────────────────────────────

  const state = {
    detectedVideos: [],
    detectedStreams: [],
    isOverlay: false,
    pageUrl: location.href,
  };

  // Expose so site modules can read/write it
  window.__nexusState = state;

  // ── Runtime message listener ────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case 'DOWNLOAD_DETECTED':
        _showDownloadBar(msg, false);
        sendResponse({ ok: true });
        break;

      case 'DOWNLOAD_INTERCEPTED':
        _showDownloadBar(msg, true);
        sendResponse({ ok: true });
        break;

      case 'PING':
        sendResponse({ ok: true, injected: true, url: location.href });
        break;

      case 'GET_STATE':
        sendResponse({ ok: true, state });
        break;

      default:
        break;
    }
  });

  // ── Download notification bar ───────────────────────────────────────────────

  function _showDownloadBar(info, intercepted) {
    if (document.hidden) return;

    const existing = document.getElementById('__nexus-intercept-bar');
    if (existing) existing.remove();

    const bar = document.createElement('div');
    bar.id = '__nexus-intercept-bar';
    Object.assign(bar.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      right: '0',
      zIndex: '2147483647',
      background: intercepted ? '#0d2e0d' : '#1a1a35',
      borderBottom: `2px solid ${intercepted ? '#4ade80' : '#6c63ff'}`,
      color: '#e8e8f0',
      font: '13px/1 -apple-system,sans-serif',
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      padding: '8px 16px',
      boxShadow: '0 2px 12px rgba(0,0,0,.5)',
    });

    const icon = intercepted ? '✔' : '⬇';
    const action = intercepted ? 'Routed to Nexus' : 'Download detected';

    const text = document.createElement('span');
    text.textContent = `${icon} ${action}: ${_truncate(info.url, 60)}`;
    text.style.flex = '1';

    const buttons = [
      intercepted
        ? null
        : _makeButton('Download with Nexus', '#6c63ff', () => {
            chrome.runtime.sendMessage({ type: 'DOWNLOAD_URL', url: info.url });
            bar.remove();
          }),
      _makeButton('Dismiss', '#555', () => bar.remove()),
    ].filter(Boolean);

    bar.append(text, ...buttons);
    document.body.prepend(bar);

    // Auto-dismiss
    setTimeout(() => bar?.isConnected && bar.remove(), intercepted ? 5000 : 10000);
  }

  function _makeButton(label, bg, onClick) {
    const btn = document.createElement('button');
    btn.textContent = label;
    Object.assign(btn.style, {
      padding: '4px 12px',
      borderRadius: '5px',
      border: 'none',
      background: bg,
      color: '#fff',
      font: '12px/1 -apple-system,sans-serif',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    });
    btn.addEventListener('click', onClick);
    return btn;
  }

  function _truncate(str, n) {
    return str && str.length > n ? str.slice(0, n) + '…' : (str || '');
  }

  // ── MutationObserver for dynamic content ────────────────────────────────────
  // Notify site modules when new nodes are added to the DOM so they can
  // inject their buttons without running their own observers at startup.

  const _domChangeCallbacks = [];

  window.__nexusOnDOMChange = function (callback) {
    _domChangeCallbacks.push(callback);
  };

  const _domObserver = new MutationObserver((mutations) => {
    // Debounce: batch calls within a single microtask
    if (_domChangeCallbacks.length === 0) return;
    const addedNodes = [];
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) addedNodes.push(node);
      }
    }
    if (addedNodes.length === 0) return;
    for (const cb of _domChangeCallbacks) {
      try { cb(addedNodes); } catch (_) {}
    }
  });

  _domObserver.observe(document.documentElement, { childList: true, subtree: true });

  // ── SPA navigation tracking ─────────────────────────────────────────────────

  (function _trackNavigation() {
    let lastHref = location.href;
    const check = () => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        state.pageUrl = lastHref;
        state.detectedVideos = [];
        state.detectedStreams = [];
      }
    };
    // Poll (covers pushState/replaceState SPAs without patching history)
    setInterval(check, 500);
  })();
})();
