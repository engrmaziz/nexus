// nexus-extension/content/sites/facebook.js
// Facebook video download support.

(function () {
  'use strict';

  const host = (() => { try { return new URL(location.href).hostname.replace(/^www\./, ''); } catch (_) { return location.hostname.replace(/^www\./, ''); } })();
  if (host !== 'facebook.com' && !host.endsWith('.facebook.com')) return;

  function injectOnVideos() {
    document.querySelectorAll('video').forEach((video) => {
      if (video.dataset.__nexusInjected) return;
      video.dataset.__nexusInjected = '1';

      const parent = video.closest('[role="article"]') || video.parentElement;
      if (!parent) return;

      if (getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative';
      }

      const btn = document.createElement('button');
      btn.textContent = '⬇ Nexus';
      btn.style.cssText = `
        position: absolute; top: 8px; right: 8px; z-index: 9999;
        background: rgba(108,99,255,.9); color: #fff; border: none;
        border-radius: 5px; padding: 4px 10px; font: bold 12px/1 sans-serif;
        cursor: pointer;
      `;

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.runtime.sendMessage({ type: 'DOWNLOAD_URL', url: location.href });
        btn.textContent = '✔ Sent';
        setTimeout(() => { btn.textContent = '⬇ Nexus'; }, 2000);
      });

      parent.appendChild(btn);
    });
  }

  injectOnVideos();
  new MutationObserver(injectOnVideos).observe(document.body, { childList: true, subtree: true });
})();
