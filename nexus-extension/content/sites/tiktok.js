// nexus-extension/content/sites/tiktok.js
// TikTok video download support.

(function () {
  'use strict';

  const host = (() => { try { return new URL(location.href).hostname.replace(/^www\./, ''); } catch (_) { return location.hostname.replace(/^www\./, ''); } })();
  if (host !== 'tiktok.com' && !host.endsWith('.tiktok.com')) return;

  const INJECTED = new WeakSet();

  function injectButtons() {
    document.querySelectorAll('video').forEach((video) => {
      if (INJECTED.has(video)) return;
      INJECTED.add(video);

      const parent = video.closest('[class*="DivVideoWrapper"], [class*="video-feed-item"]') || video.parentElement;
      if (!parent) return;
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';

      const btn = document.createElement('button');
      btn.textContent = '⬇ Nexus';
      btn.style.cssText = `
        position: absolute; top: 8px; right: 8px; z-index: 9999;
        background: rgba(108,99,255,.9); color: #fff; border: none;
        border-radius: 5px; padding: 4px 10px; font: bold 12px/1 sans-serif;
        cursor: pointer; opacity: 0; transition: opacity .2s;
      `;

      parent.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
      parent.addEventListener('mouseleave', () => { btn.style.opacity = '0'; });

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.runtime.sendMessage({ type: 'DOWNLOAD_URL', url: location.href });
        btn.textContent = '✔ Sent';
        setTimeout(() => { btn.textContent = '⬇ Nexus'; }, 2000);
      });

      parent.appendChild(btn);
    });
  }

  injectButtons();
  new MutationObserver(injectButtons).observe(document.body, { childList: true, subtree: true });
})();
