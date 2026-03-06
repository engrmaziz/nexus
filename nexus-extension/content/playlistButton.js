// nexus-extension/content/playlistButton.js
// Detects playlist pages and adds a "Download Playlist" badge.

(function () {
  'use strict';

  // Only run on known playlist-capable domains
  const PLAYLIST_DOMAINS = ['youtube.com', 'youtu.be', 'vimeo.com', 'soundcloud.com', 'bandcamp.com'];
  const host = location.hostname.replace(/^www\./, '');
  if (!PLAYLIST_DOMAINS.some((d) => host === d || host.endsWith('.' + d))) return;

  // Check whether current URL looks like a playlist
  function isPlaylistUrl(url) {
    try {
      const u = new URL(url);
      return u.searchParams.has('list') || u.pathname.includes('/playlist');
    } catch (_) { return false; }
  }

  function injectPlaylistButton() {
    if (!isPlaylistUrl(location.href)) return;
    if (document.getElementById('__nexus-playlist-btn')) return;

    const btn = document.createElement('button');
    btn.id = '__nexus-playlist-btn';
    btn.textContent = '⬇ Download Playlist with Nexus';
    btn.style.cssText = `
      position: fixed; bottom: 60px; right: 16px; z-index: 2147483640;
      background: #6c63ff; color: #fff; border: none; border-radius: 8px;
      padding: 8px 14px; font: bold 12px/1 -apple-system,sans-serif;
      cursor: pointer; box-shadow: 0 4px 14px rgba(108,99,255,.5);
      transition: opacity .2s;
    `;

    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({
        type: 'DOWNLOAD_URL',
        url: location.href,
        isPlaylist: true,
      });
      btn.textContent = '✔ Sent to Nexus';
      btn.style.background = '#4ade80';
      setTimeout(() => btn.remove(), 3000);
    });

    document.body.appendChild(btn);
  }

  // Try to inject on initial load and on navigation changes (SPA)
  injectPlaylistButton();

  let lastHref = location.href;
  const navObserver = new MutationObserver(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      document.getElementById('__nexus-playlist-btn')?.remove();
      injectPlaylistButton();
    }
  });
  navObserver.observe(document.body, { childList: true, subtree: true });
})();
