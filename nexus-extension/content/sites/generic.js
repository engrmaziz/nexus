// nexus-extension/content/sites/generic.js
// Generic download button for any page with video/audio elements or download links.

(function () {
  'use strict';

  // Avoid re-injecting on sites that already have a dedicated module
  const HANDLED_SITES = [
    'youtube.com', 'youtu.be',
    'facebook.com', 'instagram.com',
    'twitter.com', 'x.com',
    'vimeo.com', 'tiktok.com',
  ];

  const host = location.hostname.replace(/^www\./, '');
  if (HANDLED_SITES.some((s) => host === s || host.endsWith('.' + s))) return;

  function scanMediaLinks() {
    const links = Array.from(document.querySelectorAll('a[href]')).filter((a) => {
      return /\.(mp4|mkv|avi|mov|flv|webm|mp3|flac|aac|ogg|wav|zip|tar|gz|rar|exe|msi|dmg|pdf|apk)/i.test(a.href);
    });

    links.forEach((a) => {
      if (a.dataset.__nexusAdded) return;
      a.dataset.__nexusAdded = '1';

      const btn = document.createElement('span');
      btn.textContent = ' ⬇';
      btn.title = 'Download with Nexus';
      btn.style.cssText = `
        cursor: pointer; color: #6c63ff; font-weight: bold;
        margin-left: 4px; user-select: none;
      `;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        chrome.runtime.sendMessage({ type: 'DOWNLOAD_URL', url: a.href });
        btn.textContent = ' ✔';
        setTimeout(() => { btn.textContent = ' ⬇'; }, 2000);
      });

      a.after(btn);
    });
  }

  scanMediaLinks();
  new MutationObserver(scanMediaLinks).observe(document.body, { childList: true, subtree: true });
})();
