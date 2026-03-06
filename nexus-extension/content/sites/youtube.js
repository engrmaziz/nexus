// nexus-extension/content/sites/youtube.js
// YouTube-specific download button injection.

(function () {
  'use strict';

  const host = (() => { try { return new URL(location.href).hostname.replace(/^www\./, ''); } catch (_) { return location.hostname.replace(/^www\./, ''); } })();
  if (host !== 'youtube.com' && !host.endsWith('.youtube.com') && host !== 'youtu.be') return;

  const BUTTON_CONTAINER_SEL = '#above-the-fold #top-level-buttons-computed, ytd-watch-metadata #top-level-buttons-computed';
  const BTN_ID = '__nexus-yt-btn';

  function getVideoId() {
    const params = new URLSearchParams(location.search);
    return params.get('v');
  }

  function injectButton() {
    if (document.getElementById(BTN_ID)) return;
    if (!getVideoId()) return;

    const container = document.querySelector(BUTTON_CONTAINER_SEL);
    if (!container) return;

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.innerHTML = `
      <span style="display:flex;align-items:center;gap:6px;padding:0 14px;height:36px;border-radius:18px;background:#6c63ff;color:#fff;font:600 13px/1 -apple-system,sans-serif;border:none;cursor:pointer;">
        ⬇ Nexus
      </span>
    `;
    btn.style.marginLeft = '8px';

    btn.addEventListener('click', (e) => {
      const rect = btn.getBoundingClientRect();
      const formats = [
        { label: 'Best quality',  value: '' },
        { label: '4K (2160p)',    value: '4k' },
        { label: '1080p',         value: '1080p' },
        { label: '720p',          value: '720p' },
        { label: '480p',          value: '480p' },
        { label: 'Audio only (mp3)', value: 'audio' },
      ];
      window.__nexusShowQualityPanel?.(location.href, formats, rect.left, rect.bottom + 4);
    });

    container.appendChild(btn);
  }

  // Inject on initial load + SPA navigation
  let lastHref = '';
  const observer = new MutationObserver(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      document.getElementById(BTN_ID)?.remove();
      setTimeout(injectButton, 1500); // wait for YT to render buttons
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(injectButton, 2000);
})();
