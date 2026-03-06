// nexus-extension/content/playlistButton.js
// Detects playlist pages and injects a "⚡ Download Playlist" button with a
// modal showing quality selector and video count.

(function () {
  'use strict';

  const PLAYLIST_DOMAINS = ['youtube.com', 'youtu.be', 'vimeo.com', 'dailymotion.com', 'soundcloud.com'];
  const host = location.hostname.replace(/^www\./, '');
  if (!PLAYLIST_DOMAINS.some((d) => host === d || host.endsWith('.' + d))) return;

  // Selectors for counting playlist items – extracted for easy maintenance
  const VIDEO_COUNT_SELECTORS = [
    'ytd-playlist-video-renderer',   // YouTube playlist items
    'ytd-grid-video-renderer',        // YouTube channel/grid items
    '.playlist-video-item',           // Vimeo / generic
    '[data-testid="video-item"]',     // Dailymotion / others
    '.x-item-url',                    // SoundCloud tracks
  ].join(', ');

  // ── Detect playlist URL ──────────────────────────────────────────────────

  function _isPlaylistUrl(url) {
    try {
      const u = new URL(url);
      return (
        u.searchParams.has('list') ||
        /\/playlist\b/i.test(u.pathname) ||
        /\/(album|showcase)\/\d+/i.test(u.pathname) ||   // Vimeo albums
        /\/playlist\/[a-z0-9]+/i.test(u.pathname) ||      // Dailymotion
        /\/(channel\/|c\/|@)[^/]+\/videos/i.test(u.pathname) // YT channels
      );
    } catch (_) { return false; }
  }

  // ── Quality modal ────────────────────────────────────────────────────────

  const MODAL_ID  = '__nexus-playlist-modal';
  const BTN_ID    = '__nexus-playlist-btn';

  const QUALITY_OPTIONS = [
    { label: '⚡ Best quality',         value: '' },
    { label: '4K (2160p)',               value: '2160p' },
    { label: '1080p HD',                 value: '1080p' },
    { label: '720p HD',                  value: '720p'  },
    { label: '480p',                     value: '480p'  },
    { label: '360p',                     value: '360p'  },
    { label: '🎵 Audio only (MP3)',      value: 'audio' },
  ];

  function _showModal(playlistInfo) {
    document.getElementById(MODAL_ID)?.remove();

    const overlay = document.createElement('div');
    overlay.id = MODAL_ID;
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(0,0,0,.65); display: flex;
      align-items: center; justify-content: center;
    `;

    const modal = document.createElement('div');
    modal.style.cssText = `
      background: #1a1a35; border: 1px solid #2e2e5a; border-radius: 14px;
      padding: 20px 24px; min-width: 300px; max-width: 420px;
      color: #e8e8f0; font: 14px/1.5 -apple-system,sans-serif;
      box-shadow: 0 20px 60px rgba(0,0,0,.7);
    `;

    // Header
    const title = document.createElement('div');
    title.style.cssText = 'font-size:16px; font-weight:700; margin-bottom:4px;';
    title.textContent = '⚡ Download Playlist';

    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:12px; color:#9090b0; margin-bottom:16px;';
    meta.textContent = playlistInfo.label || location.href;

    // Video count (if known)
    if (playlistInfo.count) {
      const count = document.createElement('div');
      count.style.cssText = 'font-size:12px; color:#9090b0; margin-bottom:16px;';
      count.textContent = `${playlistInfo.count} videos`;
      modal.appendChild(count);
    }

    // Quality selector
    const qualLabel = document.createElement('div');
    qualLabel.style.cssText = 'font-size:11px; color:#9090b0; margin-bottom:8px; text-transform:uppercase; letter-spacing:.06em;';
    qualLabel.textContent = 'Select Quality';

    const select = document.createElement('select');
    select.style.cssText = `
      width: 100%; padding: 8px 10px; border-radius: 7px;
      background: #252548; color: #e8e8f0; border: 1px solid #3e3e6a;
      font: 13px/1 -apple-system,sans-serif; margin-bottom: 16px;
      appearance: none; cursor: pointer;
    `;
    for (const opt of QUALITY_OPTIONS) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      select.appendChild(o);
    }

    // Action buttons
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex; gap:10px;';

    const btnDownload = _makeBtn('⬇ Start Download', '#6c63ff');
    const btnCancel   = _makeBtn('Cancel', '#3e3e6a');

    btnDownload.addEventListener('click', () => {
      chrome.runtime.sendMessage({
        type: 'DOWNLOAD_PLAYLIST',
        url: location.href,
        playlistType: playlistInfo.type || 'unknown',
        playlistId: playlistInfo.id || '',
        quality: select.value,
      });
      overlay.remove();
      _showConfirmation();
    });

    btnCancel.addEventListener('click', () => overlay.remove());

    btnRow.append(btnDownload, btnCancel);

    modal.append(title, meta, qualLabel, select, btnRow);
    overlay.appendChild(modal);

    // Close on backdrop click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);
  }

  function _showConfirmation() {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      z-index: 2147483647; background: #4ade80; color: #0a2a0a;
      font: bold 13px/1 -apple-system,sans-serif; padding: 10px 20px;
      border-radius: 8px; box-shadow: 0 4px 14px rgba(0,0,0,.4);
    `;
    toast.textContent = '✔ Playlist sent to Nexus!';
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
  }

  function _makeBtn(text, bg) {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText = `
      flex:1; padding:9px 14px; border-radius:7px; border:none;
      background:${bg}; color:#fff; font:bold 13px/1 -apple-system,sans-serif;
      cursor:pointer;
    `;
    return btn;
  }

  // ── Inject floating button ───────────────────────────────────────────────

  function injectPlaylistButton() {
    if (!_isPlaylistUrl(location.href)) return;
    if (document.getElementById(BTN_ID)) return;

    // Ask background to classify the playlist
    chrome.runtime.sendMessage({ type: 'DETECT_PLAYLIST', url: location.href }, (resp) => {
      const info = resp || { isPlaylist: true, type: 'unknown', id: null, label: 'Playlist' };

      const btn = document.createElement('button');
      btn.id = BTN_ID;
      btn.textContent = '⚡ Download Playlist';
      btn.style.cssText = `
        position: fixed; bottom: 64px; right: 16px; z-index: 2147483640;
        background: #6c63ff; color: #fff; border: none; border-radius: 10px;
        padding: 10px 16px; font: bold 13px/1 -apple-system,sans-serif;
        cursor: pointer; box-shadow: 0 4px 16px rgba(108,99,255,.5);
        transition: background .15s, transform .1s;
      `;
      btn.addEventListener('mouseenter', () => { btn.style.background = '#5a51e8'; btn.style.transform = 'scale(1.04)'; });
      btn.addEventListener('mouseleave', () => { btn.style.background = '#6c63ff'; btn.style.transform = ''; });

      // Count videos on the page using the centralised selector constant
      const videoCount = document.querySelectorAll(VIDEO_COUNT_SELECTORS).length;
      if (videoCount > 0) info.count = videoCount;

      btn.addEventListener('click', () => _showModal(info));
      document.body.appendChild(btn);
    });
  }

  // Initial injection + SPA navigation
  setTimeout(injectPlaylistButton, 1500);

  let lastHref = location.href;
  new MutationObserver(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      document.getElementById(BTN_ID)?.remove();
      setTimeout(injectPlaylistButton, 1500);
    }
  }).observe(document.body, { childList: true, subtree: true });
})();
