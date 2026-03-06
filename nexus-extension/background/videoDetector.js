// nexus-extension/background/videoDetector.js
// Detects video streams present in a tab using executeScript.

export const videoDetector = {
  /**
   * Inject a small script into the target tab and collect <video> src attributes.
   * @param {number} tabId
   * @returns {Promise<{ videos: object[] }>}
   */
  async detectFromTab(tabId) {
    if (!tabId) return { videos: [] };

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: _collectVideoInfo,
      });

      const videos = results?.[0]?.result || [];
      return { videos };
    } catch (err) {
      return { videos: [], error: err.message };
    }
  },

  /**
   * Return video info from the storage cache for a given URL.
   */
  async getDetectedForUrl(url) {
    return new Promise((resolve) => {
      chrome.storage.session.get(['detectedVideos'], (data) => {
        const all = data.detectedVideos || {};
        resolve(all[url] || []);
      });
    });
  },

  /**
   * Cache detected video info keyed by page URL.
   */
  async cacheForUrl(url, videos) {
    return new Promise((resolve) => {
      chrome.storage.session.get(['detectedVideos'], (data) => {
        const all = data.detectedVideos || {};
        all[url] = videos;
        chrome.storage.session.set({ detectedVideos: all }, resolve);
      });
    });
  },
};

/**
 * Injected function – runs in page context.
 * Collects info about all <video> and <audio> elements on the page.
 */
function _collectVideoInfo() {
  const results = [];

  document.querySelectorAll('video, audio').forEach((el) => {
    const src = el.currentSrc || el.src;
    if (!src || src.startsWith('blob:')) {
      // Try to get blob URL info from source elements
      const sources = Array.from(el.querySelectorAll('source')).map((s) => ({
        src: s.src,
        type: s.type,
      })).filter((s) => s.src);
      if (sources.length > 0) {
        results.push({ type: el.tagName.toLowerCase(), sources, title: document.title });
      }
      return;
    }
    results.push({
      type: el.tagName.toLowerCase(),
      src,
      duration: el.duration,
      width: el.videoWidth,
      height: el.videoHeight,
      title: document.title || src,
    });
  });

  // Also check for OG video meta
  const ogVideo = document.querySelector('meta[property="og:video:url"], meta[property="og:video"]');
  if (ogVideo) {
    results.push({ type: 'og', src: ogVideo.content, title: document.title });
  }

  return results;
}
