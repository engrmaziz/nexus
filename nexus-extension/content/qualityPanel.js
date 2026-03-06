// nexus-extension/content/qualityPanel.js
// Floating quality selection panel – fetches stream info from the background
// service worker before rendering quality rows with color-coded badges.

(function () {
  'use strict';

  const PANEL_ID = '__nexus-quality-panel';

  // Color coding per resolution
  const QUALITY_COLORS = {
    '2160': '#9333ea',  // 4K   – purple
    '4k':   '#9333ea',
    '1440': '#7c3aed',  // 1440p
    '1080': '#2563eb',  // 1080p – blue
    '720':  '#16a34a',  // 720p  – green
    '480':  '#ca8a04',  // 480p  – yellow
    '360':  '#ea580c',  // 360p  – orange
    'audio': '#db2777', // audio – pink
    'best':  '#6c63ff',
  };

  function _badgeColor(label) {
    const l = (label || '').toLowerCase();
    for (const [key, color] of Object.entries(QUALITY_COLORS)) {
      if (l.includes(key)) return color;
    }
    return QUALITY_COLORS.best;
  }

  /**
   * Show the quality panel, fetching stream analysis from the background
   * before rendering the quality rows.
   *
   * @param {string}   url      Download / stream URL
   * @param {object[]} formats  Pre-built format list (may be empty — panel fetches its own)
   * @param {number}   x        Left position (clamped to viewport)
   * @param {number}   y        Top position  (clamped to viewport)
   */
  window.__nexusShowQualityPanel = function showQualityPanel(url, formats, x, y) {
    document.getElementById(PANEL_ID)?.remove();

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = `
      position: fixed; z-index: 2147483647;
      left: ${Math.min(x, window.innerWidth  - 240)}px;
      top:  ${Math.min(y, window.innerHeight - 260)}px;
      background: #1a1a35; border: 1px solid #2e2e5a; border-radius: 12px;
      padding: 10px 8px; min-width: 210px;
      box-shadow: 0 10px 36px rgba(0,0,0,.65);
      color: #e8e8f0; font: 13px/1 -apple-system,sans-serif;
    `;

    // Close on outside click
    const _closer = (e) => {
      if (!panel.contains(e.target)) {
        panel.remove();
        document.removeEventListener('click', _closer, true);
      }
    };
    setTimeout(() => document.addEventListener('click', _closer, true), 80);

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'font-weight:700; font-size:11px; color:#9090b0; padding:2px 10px 8px; letter-spacing:.05em; text-transform:uppercase;';
    header.textContent = 'SELECT QUALITY';
    panel.appendChild(header);

    // Loading state
    const loading = document.createElement('div');
    loading.style.cssText = 'padding:8px 10px; color:#9090b0; font-size:12px;';
    loading.textContent = '⏳ Analyzing stream…';
    panel.appendChild(loading);

    document.body.appendChild(panel);

    // ── Fetch stream info from background ─────────────────────────────────
    chrome.runtime.sendMessage({ type: 'ANALYZE_STREAM', url }, (streamData) => {
      loading.remove();

      let resolvedFormats = formats && formats.length > 0 ? formats : null;

      if (streamData && !streamData.error) {
        if (streamData.variants && streamData.variants.length > 0) {
          // HLS master playlist
          resolvedFormats = streamData.variants.map((v) => ({
            label: v.resolution ? `${v.resolution} (${Math.round(v.bandwidth / 1000)}k)` : `${Math.round(v.bandwidth / 1000)}kbps`,
            value: v.url,
            direct: true,
          }));
          resolvedFormats.unshift({ label: '⚡ Best quality', value: url });
        } else if (streamData.videoTracks && streamData.videoTracks.length > 0) {
          // DASH manifest
          resolvedFormats = streamData.videoTracks.map((t) => ({
            label: t.width && t.height ? `${t.height}p (${Math.round(t.bandwidth / 1000)}k)` : `${Math.round(t.bandwidth / 1000)}kbps`,
            value: t.url || url,
            direct: !!t.url,
          }));
          for (const a of (streamData.audioTracks || [])) {
            resolvedFormats.push({
              label: `🎵 Audio${a.lang ? ' (' + a.lang + ')' : ''} (${Math.round(a.bandwidth / 1000)}k)`,
              value: a.url || url,
              direct: !!a.url,
            });
          }
          resolvedFormats.unshift({ label: '⚡ Best quality', value: url });
        } else if (streamData.size) {
          // Direct file (MP4/audio/etc.)
          const mb = (streamData.size / 1048576).toFixed(1);
          resolvedFormats = [
            { label: `⬇ Download (${mb} MB)${streamData.resumable ? ' ⟳' : ''}`, value: url },
          ];
        }
      }

      // Fall back to default list
      if (!resolvedFormats || resolvedFormats.length === 0) {
        resolvedFormats = [
          { label: '⚡ Best quality',     value: ''      },
          { label: '4K (2160p)',           value: '2160p' },
          { label: '1080p HD',             value: '1080p' },
          { label: '720p HD',              value: '720p'  },
          { label: '480p',                 value: '480p'  },
          { label: '360p',                 value: '360p'  },
          { label: '🎵 Audio only (MP3)', value: 'audio' },
        ];
      }

      for (const fmt of resolvedFormats) {
        panel.appendChild(_makeRow(fmt, url, panel));
      }
    });
  };

  function _makeRow(fmt, fallbackUrl, panel) {
    const row = document.createElement('button');
    row.style.cssText = `
      display: flex; align-items: center; gap: 8px;
      width: 100%; text-align: left; padding: 7px 10px;
      border: none; background: transparent; color: #e8e8f0;
      border-radius: 6px; cursor: pointer;
      font: 13px/1 -apple-system,sans-serif;
    `;

    // Color badge
    const badge = document.createElement('span');
    badge.style.cssText = `
      display: inline-block; width: 8px; height: 8px; border-radius: 50%;
      background: ${_badgeColor(fmt.label)}; flex-shrink: 0;
    `;

    const label = document.createElement('span');
    label.textContent = fmt.label;
    label.style.flex = '1';

    row.append(badge, label);

    row.addEventListener('mouseenter', () => { row.style.background = '#252548'; });
    row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });

    row.addEventListener('click', () => {
      // If `direct` is set the value IS the URL; otherwise it's a quality token
      if (fmt.direct && fmt.value) {
        chrome.runtime.sendMessage({ type: 'DOWNLOAD_URL', url: fmt.value });
      } else {
        chrome.runtime.sendMessage({ type: 'DOWNLOAD_URL', url: fallbackUrl, quality: fmt.value });
      }
      panel.remove();
    });

    return row;
  }
})();
