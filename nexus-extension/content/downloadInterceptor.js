// nexus-extension/content/downloadInterceptor.js
// Intercepts clicks on <a download> links and offers to route them through Nexus.

(function () {
  'use strict';

  const LARGE_THRESHOLD = 5 * 1024 * 1024; // 5 MB

  // Whether to always intercept downloads (can be toggled in settings)
  let alwaysIntercept = false;

  // Load setting
  chrome.storage.sync.get(['alwaysIntercept'], (data) => {
    alwaysIntercept = !!data.alwaysIntercept;
  });

  document.addEventListener('click', handleClick, true);

  function handleClick(e) {
    const anchor = e.target.closest('a');
    if (!anchor) return;

    const href = anchor.href;
    // Reject unsafe or non-downloadable URL schemes early
    if (!href || /^(javascript:|data:|vbscript:|#)/i.test(href)) return;

    const hasDownloadAttr = anchor.hasAttribute('download');
    const ext = getExtension(href);
    const isDownloadExt = /\.(zip|tar|gz|bz2|7z|rar|exe|msi|dmg|deb|rpm|apk|mp4|mkv|avi|mov|flv|webm|mp3|flac|aac|pdf|iso)/i.test(ext);

    // Reject dangerous URL schemes
    try {
      const scheme = new URL(href).protocol;
      if (scheme !== 'http:' && scheme !== 'https:' && scheme !== 'ftp:' && scheme !== 'blob:') return;
    } catch (_) { return; }

    if (!hasDownloadAttr && !isDownloadExt && !alwaysIntercept) return;

    e.preventDefault();
    e.stopPropagation();

    offerDownload(href, anchor.getAttribute('download') || '');
  }

  function offerDownload(url, suggestedName) {
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
    urlText.textContent = truncate(url, 80);

    const buttons = document.createElement('div');
    buttons.style.cssText = 'display: flex; gap: 8px;';

    const btnNexus = makeBtn('Download with Nexus', '#6c63ff', () => {
      chrome.runtime.sendMessage({
        type: 'DOWNLOAD_URL',
        url,
        filename: suggestedName || undefined,
      });
      bar.remove();
    });

    const btnBrowser = makeBtn('Use Browser', '#444', () => {
      bar.remove();
      // Trigger native download
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

    setTimeout(() => bar?.remove(), 12000);
  }

  function makeBtn(text, bg, onClick) {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText = `
      flex: 1; padding: 5px 10px; border-radius: 5px; border: none;
      background: ${bg}; color: #fff; font: 12px/1 sans-serif; cursor: pointer;
    `;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function getExtension(url) {
    try {
      return new URL(url).pathname.match(/\.[^./?]+$/)?.[0] || '';
    } catch (_) { return ''; }
  }

  function truncate(str, n) {
    return str.length > n ? str.slice(0, n) + '…' : str;
  }
})();
