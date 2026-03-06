// nexus-extension/content/sites/twitter.js
// Twitter / X video download support.

(function () {
  'use strict';

  const host = (() => { try { return new URL(location.href).hostname.replace(/^www\./, ''); } catch (_) { return location.hostname.replace(/^www\./, ''); } })();
  if (host !== 'twitter.com' && !host.endsWith('.twitter.com') && host !== 'x.com' && !host.endsWith('.x.com')) return;

  const INJECTED = new WeakSet();

  function injectButtons() {
    // Tweet articles that contain a video
    document.querySelectorAll('article[data-testid="tweet"]').forEach((tweet) => {
      if (INJECTED.has(tweet)) return;
      const video = tweet.querySelector('video');
      if (!video) return;

      INJECTED.add(tweet);
      if (getComputedStyle(tweet).position === 'static') tweet.style.position = 'relative';

      // Find the tweet URL from its timestamp link
      const timeLink = tweet.querySelector('time')?.closest('a');
      const tweetUrl = timeLink?.href || location.href;

      const btn = document.createElement('button');
      btn.textContent = '⬇ Nexus';
      btn.style.cssText = `
        position: absolute; top: 8px; right: 8px; z-index: 9999;
        background: rgba(108,99,255,.9); color: #fff; border: none;
        border-radius: 5px; padding: 4px 10px; font: bold 12px/1 sans-serif;
        cursor: pointer;
      `;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.runtime.sendMessage({ type: 'DOWNLOAD_URL', url: tweetUrl });
        btn.textContent = '✔ Sent';
        setTimeout(() => { btn.textContent = '⬇ Nexus'; }, 2000);
      });

      tweet.appendChild(btn);
    });
  }

  injectButtons();
  new MutationObserver(injectButtons).observe(document.body, { childList: true, subtree: true });
})();
