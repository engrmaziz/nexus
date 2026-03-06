// nexus-extension/content/sites/vimeo.js
// Vimeo video download support.

(function () {
  'use strict';

  const host = (() => { try { return new URL(location.href).hostname.replace(/^www\./, ''); } catch (_) { return location.hostname.replace(/^www\./, ''); } })();
  if (host !== 'vimeo.com' && !host.endsWith('.vimeo.com')) return;

  const BTN_ID = '__nexus-vimeo-btn';

  function injectButton() {
    if (document.getElementById(BTN_ID)) return;
    // Vimeo video pages have numeric IDs in the path
    if (!/\/\d+/.test(location.pathname)) return;

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.textContent = '⬇ Download with Nexus';
    btn.style.cssText = `
      position: fixed; bottom: 16px; right: 16px; z-index: 2147483640;
      background: #6c63ff; color: #fff; border: none; border-radius: 8px;
      padding: 8px 14px; font: bold 12px/1 -apple-system,sans-serif;
      cursor: pointer; box-shadow: 0 4px 14px rgba(108,99,255,.5);
    `;

    btn.addEventListener('click', () => {
      const formats = [
        { label: 'Best quality', value: '' },
        { label: '1080p', value: '1080p' },
        { label: '720p',  value: '720p'  },
        { label: '480p',  value: '480p'  },
      ];
      const rect = btn.getBoundingClientRect();
      window.__nexusShowQualityPanel?.(location.href, formats, rect.left, rect.top - 160);
    });

    document.body.appendChild(btn);
  }

  setTimeout(injectButton, 1000);
  let lastPath = location.pathname;
  new MutationObserver(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      document.getElementById(BTN_ID)?.remove();
      setTimeout(injectButton, 1000);
    }
  }).observe(document.body, { childList: true, subtree: true });
})();
