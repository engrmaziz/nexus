// nexus-extension/content/videoButton.js
// Injects a floating "⚡ Nexus" download button over every <video> element,
// showing a color-coded quality panel on click.

(function () {
  'use strict';

  // Color coding per resolution tier
  const QUALITY_COLORS = {
    '4k':    '#9333ea', // purple
    '2160':  '#9333ea',
    '1440':  '#7c3aed',
    '1080':  '#2563eb', // blue
    '720':   '#16a34a', // green
    '480':   '#ca8a04', // yellow
    '360':   '#ea580c', // orange
    'audio': '#db2777', // pink
    'best':  '#6c63ff', // default purple-blue
  };

  function _qualityColor(label) {
    const l = label.toLowerCase();
    for (const [key, color] of Object.entries(QUALITY_COLORS)) {
      if (l.includes(key)) return color;
    }
    return QUALITY_COLORS.best;
  }

  const injected = new WeakSet();

  function injectButton(video) {
    if (injected.has(video)) return;
    injected.add(video);

    const wrap = document.createElement('div');
    wrap.className = '__nexus-vbtn-wrap';
    wrap.style.cssText = `
      position: absolute; top: 8px; right: 8px; z-index: 2147483640;
      pointer-events: none;
    `;

    const btn = document.createElement('button');
    btn.className = '__nexus-vbtn';
    btn.innerHTML = '⚡ Nexus';
    btn.style.cssText = `
      pointer-events: all; padding: 5px 12px; border-radius: 6px;
      background: rgba(108,99,255,.88); color: #fff;
      font: bold 12px/1 -apple-system,sans-serif;
      border: 1px solid rgba(255,255,255,.2); cursor: pointer;
      backdrop-filter: blur(6px);
      opacity: 0; transition: opacity .2s;
      box-shadow: 0 2px 8px rgba(0,0,0,.4);
    `;

    wrap.appendChild(btn);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();

      const src = video.currentSrc || video.src;
      const pageUrl = location.href;

      // Ask background for any known streams for this tab
      chrome.runtime.sendMessage({ type: 'GET_STREAMS' }, (resp) => {
        const streams = resp?.streams || [];
        const formats = _buildFormatList(src, streams);
        const rect = btn.getBoundingClientRect();
        window.__nexusShowQualityPanel?.(src || pageUrl, formats, rect.left, rect.bottom + 6);
      });
    });

    video.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
    video.addEventListener('mouseleave', () => { btn.style.opacity = '0'; });

    const parent = video.parentElement;
    if (!parent) return;

    const parentPos = window.getComputedStyle(parent).position;
    if (parentPos === 'static') parent.style.position = 'relative';

    parent.appendChild(wrap);
  }

  function _buildFormatList(src, streams) {
    // Start with standard quality options
    const formats = [
      { label: '⬇ Best quality',        value: '',      color: QUALITY_COLORS.best  },
      { label: '4K (2160p)',             value: '2160p', color: QUALITY_COLORS['4k'] },
      { label: '1080p HD',               value: '1080p', color: QUALITY_COLORS['1080'] },
      { label: '720p HD',                value: '720p',  color: QUALITY_COLORS['720']  },
      { label: '480p',                   value: '480p',  color: QUALITY_COLORS['480']  },
      { label: '360p',                   value: '360p',  color: QUALITY_COLORS['360']  },
      { label: '🎵 Audio only (MP3)',    value: 'audio', color: QUALITY_COLORS.audio   },
    ];

    // Prepend any network-detected stream URLs as direct download options
    for (const s of streams) {
      if (s.type === 'hls' || s.type === 'dash') {
        formats.unshift({
          label: `⚡ ${s.type.toUpperCase()} stream`,
          value: s.url || s.src,
          direct: true,
          color: '#6c63ff',
        });
      }
    }

    return formats;
  }

  function scanAndInject() {
    document.querySelectorAll('video').forEach(injectButton);
  }

  scanAndInject();

  // Watch for dynamically inserted videos
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'VIDEO') injectButton(node);
        node.querySelectorAll?.('video')?.forEach(injectButton);
      }
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
