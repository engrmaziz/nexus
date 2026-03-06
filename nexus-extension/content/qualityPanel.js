// nexus-extension/content/qualityPanel.js
// Shows a floating quality selection panel when the user wants to download a video.

(function () {
  'use strict';

  const PANEL_ID = '__nexus-quality-panel';

  /**
   * Show the quality panel anchored near (x, y).
   * @param {string} url  URL to download
   * @param {object[]} formats  [{ label, value }]  e.g. [{ label: '1080p', value: '1080p' }]
   * @param {number} x
   * @param {number} y
   */
  window.__nexusShowQualityPanel = function showQualityPanel(url, formats, x, y) {
    document.getElementById(PANEL_ID)?.remove();

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = `
      position: fixed; z-index: 2147483647;
      left: ${Math.min(x, window.innerWidth - 220)}px;
      top: ${Math.min(y, window.innerHeight - 200)}px;
      background: #1a1a35; border: 1px solid #2e2e5a; border-radius: 10px;
      padding: 10px; min-width: 180px;
      box-shadow: 0 8px 30px rgba(0,0,0,.6);
      color: #e8e8f0; font: 13px/1 -apple-system,sans-serif;
    `;

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:700; margin-bottom:8px; font-size:12px; color:#9090b0;';
    title.textContent = 'SELECT QUALITY';
    panel.appendChild(title);

    const qualityList = formats.length > 0 ? formats : [
      { label: 'Best quality', value: '' },
      { label: '1080p', value: '1080p' },
      { label: '720p',  value: '720p'  },
      { label: '480p',  value: '480p'  },
      { label: '360p',  value: '360p'  },
    ];

    for (const fmt of qualityList) {
      const item = document.createElement('button');
      item.textContent = fmt.label;
      item.style.cssText = `
        display: block; width: 100%; text-align: left; padding: 7px 10px;
        border: none; background: transparent; color: #e8e8f0;
        border-radius: 5px; cursor: pointer; font: 13px/1 -apple-system,sans-serif;
      `;
      item.addEventListener('mouseenter', () => { item.style.background = '#252548'; });
      item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
      item.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'DOWNLOAD_URL', url, quality: fmt.value });
        panel.remove();
      });
      panel.appendChild(item);
    }

    // Close on outside click
    const closer = (e) => {
      if (!panel.contains(e.target)) {
        panel.remove();
        document.removeEventListener('click', closer, true);
      }
    };
    setTimeout(() => document.addEventListener('click', closer, true), 100);

    document.body.appendChild(panel);
  };
})();
