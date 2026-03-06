// nexus-extension/content/sites/instagram.js
// Instagram photo/video/reel download support.

(function () {
  'use strict';

  const host = (() => { try { return new URL(location.href).hostname.replace(/^www\./, ''); } catch (_) { return location.hostname.replace(/^www\./, ''); } })();
  if (host !== 'instagram.com' && !host.endsWith('.instagram.com')) return;

  const INJECTED = new WeakSet();

  function injectButtons() {
    // Posts / reels
    document.querySelectorAll('article, [role="presentation"]').forEach((article) => {
      if (INJECTED.has(article)) return;
      INJECTED.add(article);

      if (getComputedStyle(article).position === 'static') {
        article.style.position = 'relative';
      }

      const btn = makeBtn();
      btn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'DOWNLOAD_URL', url: location.href });
        btn.textContent = '✔ Sent';
        btn.style.background = 'rgba(74,222,128,.9)';
        setTimeout(() => { btn.textContent = '⬇ Nexus'; btn.style.background = 'rgba(108,99,255,.9)'; }, 2000);
      });

      article.appendChild(btn);
    });
  }

  function makeBtn() {
    const btn = document.createElement('button');
    btn.textContent = '⬇ Nexus';
    btn.style.cssText = `
      position: absolute; top: 8px; right: 8px; z-index: 9999;
      background: rgba(108,99,255,.9); color: #fff; border: none;
      border-radius: 5px; padding: 4px 10px; font: bold 12px/1 sans-serif;
      cursor: pointer;
    `;
    return btn;
  }

  injectButtons();
  new MutationObserver(injectButtons).observe(document.body, { childList: true, subtree: true });
})();
