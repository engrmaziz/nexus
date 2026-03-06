// nexus-extension/content/sites/youtube.js
// YouTube-specific download button injection with SPA navigation support,
// Shorts, Theater Mode, Fullscreen, and playlist handling.

(function () {
  'use strict';

  const host = (() => {
    try { return new URL(location.href).hostname.replace(/^www\./, ''); } catch (_) { return location.hostname.replace(/^www\./, ''); }
  })();
  if (host !== 'youtube.com' && !host.endsWith('.youtube.com') && host !== 'youtu.be') return;

  const BTN_ID = '__nexus-yt-btn';

  // Selectors for the YouTube toolbar where we inject the button
  const TOOLBAR_SELECTORS = [
    '#above-the-fold #top-level-buttons-computed',
    'ytd-watch-metadata #top-level-buttons-computed',
    '#actions-inner #top-level-buttons-computed',
    // Fallback: any toolbar in the watch page
    'ytd-watch-flexy #top-level-buttons-computed',
  ];

  // Quality formats with color tokens
  const FORMATS = [
    { label: '⚡ Best quality',      value: ''      },
    { label: '4K (2160p)',           value: '2160p' },
    { label: '1080p HD',             value: '1080p' },
    { label: '720p HD',              value: '720p'  },
    { label: '480p',                 value: '480p'  },
    { label: '360p',                 value: '360p'  },
    { label: '🎵 Audio only (MP3)', value: 'audio' },
  ];

  // ── Helpers ────────────────────────────────────────────────────────────────

  function _getVideoId() {
    try {
      return new URLSearchParams(location.search).get('v');
    } catch (_) { return null; }
  }

  function _isShorts() {
    return location.pathname.startsWith('/shorts/');
  }

  function _isPlaylist() {
    try {
      const u = new URLSearchParams(location.search);
      return u.has('list') && !u.has('v'); // pure playlist page (not video + list)
    } catch (_) { return false; }
  }

  // ── Button injection ───────────────────────────────────────────────────────

  function injectButton() {
    if (document.getElementById(BTN_ID)) return;
    if (!_getVideoId() && !_isShorts()) return;

    const container = TOOLBAR_SELECTORS.reduce((found, sel) => found || document.querySelector(sel), null);
    if (!container) return;

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.setAttribute('aria-label', 'Download with Nexus');
    btn.style.cssText = `
      display: inline-flex; align-items: center; gap: 6px;
      height: 36px; padding: 0 14px; border-radius: 18px;
      background: #6c63ff; color: #fff;
      font: 600 13px/1 -apple-system,sans-serif;
      border: none; cursor: pointer; margin-left: 8px;
      transition: background .15s, transform .1s;
    `;
    btn.innerHTML = '⚡ Nexus';

    btn.addEventListener('mouseenter', () => {
      btn.style.background = '#5a51e8';
      btn.style.transform = 'scale(1.04)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = '#6c63ff';
      btn.style.transform = '';
    });

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const rect = btn.getBoundingClientRect();
      window.__nexusShowQualityPanel?.(location.href, FORMATS, rect.left, rect.bottom + 4);
    });

    container.appendChild(btn);
  }

  // ── SPA navigation (yt-navigate-finish event) ──────────────────────────────

  window.addEventListener('yt-navigate-finish', () => {
    document.getElementById(BTN_ID)?.remove();
    setTimeout(injectButton, 1200);
  });

  // Also watch for DOM mutations (fallback)
  let lastHref = location.href;
  new MutationObserver(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      document.getElementById(BTN_ID)?.remove();
      setTimeout(injectButton, 1500);
    }
  }).observe(document.body, { childList: true, subtree: true });

  // Initial injection
  setTimeout(injectButton, 2000);

  // ── Playlist page: defer to playlistButton.js ──────────────────────────────
  // playlistButton.js already handles the playlist download button, so we
  // only handle video-level injection here.
})();
