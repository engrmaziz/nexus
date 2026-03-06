// nexus-extension/content/videoButton.js
// Injects a floating "Download" button over <video> elements on the page.

(function () {
  'use strict';

  const BUTTON_ID_PREFIX = '__nexus-vbtn-';
  const injected = new WeakSet();

  function injectButton(video) {
    if (injected.has(video)) return;
    injected.add(video);

    const wrap = document.createElement('div');
    wrap.style.cssText = `
      position: absolute; top: 8px; right: 8px; z-index: 2147483640;
      pointer-events: none;
    `;

    const btn = document.createElement('button');
    btn.textContent = '⬇ Nexus';
    btn.style.cssText = `
      pointer-events: all; padding: 4px 10px; border-radius: 5px;
      background: rgba(108,99,255,.85); color: #fff; font: bold 11px/1 sans-serif;
      border: none; cursor: pointer; backdrop-filter: blur(4px);
      opacity: 0; transition: opacity .2s;
    `;

    wrap.appendChild(btn);

    // Position relative to the video's offset parent
    const positionButton = () => {
      const rect = video.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 60) { wrap.style.display = 'none'; return; }
      wrap.style.display = '';
    };

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const src = video.currentSrc || video.src;
      if (!src || src.startsWith('blob:')) {
        // Notify background to try yt-dlp style extraction
        chrome.runtime.sendMessage({ type: 'DOWNLOAD_URL', url: location.href });
      } else {
        chrome.runtime.sendMessage({ type: 'DOWNLOAD_URL', url: src });
      }
    });

    // Show button on video hover
    video.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
    video.addEventListener('mouseleave', () => { btn.style.opacity = '0'; });

    // Use a relative-positioned parent wrapper
    const parent = video.parentElement;
    if (!parent) return;

    const parentPos = window.getComputedStyle(parent).position;
    if (parentPos === 'static') parent.style.position = 'relative';

    parent.appendChild(wrap);
    positionButton();
  }

  function scanAndInject() {
    document.querySelectorAll('video').forEach(injectButton);
  }

  // Initial scan
  scanAndInject();

  // Observe DOM mutations for dynamically added videos
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
