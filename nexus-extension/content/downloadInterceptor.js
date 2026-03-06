// nexus-extension/content/downloadInterceptor.js
// Intercepts <a download> clicks AND window.open() calls for downloadable URLs,
// routing them through the Nexus desktop app.

(function () {
  'use strict';

  const DOWNLOAD_EXT_RE = /\.(zip|tar|gz|bz2|7z|rar|exe|msi|dmg|deb|rpm|apk|mp4|mkv|avi|mov|flv|webm|mp3|flac|aac|wav|ogg|pdf|iso)(\?|$)/i;
  const SAFE_SCHEMES    = new Set(['http:', 'https:', 'ftp:']);

  let alwaysIntercept = false;

  // Load setting
  chrome.storage.sync.get(['alwaysIntercept'], (data) => {
    alwaysIntercept = !!data.alwaysIntercept;
  });

  // ── <a> tag interception ────────────────────────────────────────────────────

  document.addEventListener('click', _handleClick, true);

  function _handleClick(e) {
    const anchor = e.target.closest('a');
    if (!anchor) return;

    const href = anchor.href;
    if (!href) return;

    // Reject dangerous schemes immediately
    let scheme;
    try {
      scheme = new URL(href).protocol;
    } catch (_) { return; }

    if (!SAFE_SCHEMES.has(scheme)) return;

    // Reject inline anchors and data URIs
    if (/^(javascript:|data:|vbscript:|#)/i.test(href)) return;

    const hasDownloadAttr = anchor.hasAttribute('download');
    const isDownloadExt   = DOWNLOAD_EXT_RE.test(href);

    if (!hasDownloadAttr && !isDownloadExt && !alwaysIntercept) return;

    e.preventDefault();
    e.stopPropagation();

    _offerDownload(href, anchor.getAttribute('download') || '');
  }

  // ── window.open() interception ──────────────────────────────────────────────

  const _originalOpen = window.open.bind(window);

  window.open = function (url, target, features) {
    if (!url) return _originalOpen(url, target, features);

    let scheme, parsedUrl;
    try {
      parsedUrl = new URL(url, location.href);
      scheme = parsedUrl.protocol;
    } catch (_) {
      return _originalOpen(url, target, features);
    }

    if (!SAFE_SCHEMES.has(scheme)) return _originalOpen(url, target, features);

    const fullUrl = parsedUrl.href;

    if (DOWNLOAD_EXT_RE.test(fullUrl) || alwaysIntercept) {
      // Route to Nexus instead of opening a popup window.
      // We return null here, which deviates from the standard window.open() contract
      // (normally returns a Window object). This is intentional: the download is handled
      // by Nexus so no browser window needs to be created.
      _offerDownload(fullUrl, '');
      return null;
    }

    return _originalOpen(url, target, features);
  };

  // ── UI helper ──────────────────────────────────────────────────────────────

  function _offerDownload(url, suggestedName) {
    const existing = document.getElementById('__nexus-dl-offer');
    if (existing) existing.remove();

    const bar = document.createElement('div');
    bar.id = '__nexus-dl-offer';
    bar.style.cssText = `
      position: fixed; bottom: 16px; right: 16px; z-index: 2147483647;
      background: #1a1a35; border: 1px solid #6c63ff; border-radius: 10px;
      color: #e8e8f0; font: 13px/1 -apple-system,sans-serif;
      padding: 12px 16px; display: flex; flex-direction: column; gap: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,.6); max-width: 360px;
    `;

    const title = document.createElement('div');
    title.style.fontWeight = '600';
    title.textContent = '⬇ Download intercepted';

    const urlText = document.createElement('div');
    urlText.style.cssText = 'font-size: 11px; color: #9090b0; word-break: break-all;';
    urlText.textContent = _truncate(url, 80);

    const buttons = document.createElement('div');
    buttons.style.cssText = 'display: flex; gap: 8px;';

    const btnNexus = _makeBtn('⚡ Download with Nexus', '#6c63ff', () => {
      chrome.runtime.sendMessage({
        type: 'DOWNLOAD_URL',
        url,
        filename: suggestedName || undefined,
        pageTitle: document.title || '',
        pageUrl: window.location.href || '',
      });
      bar.remove();
    });

    const btnBrowser = _makeBtn('Use Browser', '#444', () => {
      bar.remove();
      const a = document.createElement('a');
      a.href = url;
      if (suggestedName) a.download = suggestedName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });

    buttons.append(btnNexus, btnBrowser);
    bar.append(title, urlText, buttons);
    document.body.appendChild(bar);

    setTimeout(() => bar?.isConnected && bar.remove(), 15000);
  }

  function _makeBtn(text, bg, onClick) {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText = `
      flex: 1; padding: 5px 10px; border-radius: 5px; border: none;
      background: ${bg}; color: #fff; font: 12px/1 sans-serif; cursor: pointer;
    `;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function _truncate(str, n) {
    return str && str.length > n ? str.slice(0, n) + '…' : (str || '');
  }
})();
