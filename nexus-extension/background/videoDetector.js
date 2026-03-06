// nexus-extension/background/videoDetector.js
// Detects MP4, WebM, HLS (m3u8), and DASH (mpd) streams per tab.

// Map<tabId, stream[]>  –  cleared on navigation
const streamsByTab = new Map();

export const videoDetector = {
  /**
   * Inject a script into the target tab to collect <video> src attributes,
   * then merge with any network-intercepted streams stored for that tab.
   * @param {number} tabId
   * @returns {Promise<{ videos: object[] }>}
   */
  async detectFromTab(tabId) {
    if (!tabId) return { videos: [] };

    // DOM-based detection via scripting API
    let domVideos = [];
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: _collectVideoInfo,
      });
      domVideos = results?.[0]?.result || [];
    } catch (_) {}

    // Merge with network-intercepted streams
    const networkStreams = streamsByTab.get(tabId) || [];
    const combined = _mergeStreams(domVideos, networkStreams);

    return { videos: combined };
  },

  /**
   * Record a detected stream for the given tab (called from network listeners).
   * @param {number} tabId
   * @param {{ url: string, type: string, mimeType?: string }} stream
   */
  addStream(tabId, stream) {
    if (!tabId || !stream?.url) return;
    const existing = streamsByTab.get(tabId) || [];
    // Deduplicate by URL
    if (!existing.some((s) => s.url === stream.url)) {
      existing.push({ ...stream, detectedAt: Date.now() });
      streamsByTab.set(tabId, existing);
    }
  },

  /**
   * Return all stored streams for a tab.
   * @param {number} tabId
   * @returns {object[]}
   */
  getStreams(tabId) {
    return streamsByTab.get(tabId) || [];
  },

  /**
   * Clear all stored streams for a tab (on navigation).
   * @param {number} tabId
   */
  clearTab(tabId) {
    streamsByTab.delete(tabId);
  },

  /**
   * Return the underlying map (for inspection/testing).
   */
  get streamsByTab() {
    return streamsByTab;
  },

  /**
   * Initialize navigation listeners to clear streams on page change.
   */
  init() {
    if (chrome.webNavigation) {
      chrome.webNavigation.onCommitted.addListener((details) => {
        // Only clear for top-level navigation (not iframes)
        if (details.frameId === 0) {
          streamsByTab.delete(details.tabId);
        }
      });
    }

    if (chrome.tabs) {
      chrome.tabs.onRemoved.addListener((tabId) => {
        streamsByTab.delete(tabId);
      });
    }

    // Intercept HLS / DASH / video responses from the network
    chrome.webRequest.onHeadersReceived.addListener(
      (details) => {
        const headers = {};
        for (const h of (details.responseHeaders || [])) {
          headers[h.name.toLowerCase()] = h.value;
        }
        const ct = (headers['content-type'] || '').toLowerCase();
        const url = details.url;
        const tabId = details.tabId;

        if (tabId <= 0) return;

        let type = null;
        if (ct.includes('mpegurl') || ct.includes('x-mpegurl') || /\.m3u8(\?|$)/i.test(url)) {
          type = 'hls';
        } else if (ct.includes('dash+xml') || /\.mpd(\?|$)/i.test(url)) {
          type = 'dash';
        } else if (ct.startsWith('video/') || /\.(mp4|webm|mkv|mov|avi|flv|ts|m4v)(\?|$)/i.test(url)) {
          type = 'video';
        } else if (ct.startsWith('audio/') || /\.(mp3|aac|flac|ogg|wav|m4a|opus)(\?|$)/i.test(url)) {
          type = 'audio';
        }

        if (type) {
          videoDetector.addStream(tabId, { url, type, mimeType: ct });
        }
      },
      { urls: ['<all_urls>'] },
      ['responseHeaders']
    );
  },
};

// ── Internal helpers ──────────────────────────────────────────────────────────

function _mergeStreams(domVideos, networkStreams) {
  const seen = new Set(domVideos.map((v) => v.src || v.url).filter(Boolean));
  const merged = [...domVideos];
  for (const ns of networkStreams) {
    if (!seen.has(ns.url)) {
      merged.push({ src: ns.url, type: ns.type, mimeType: ns.mimeType });
      seen.add(ns.url);
    }
  }
  return merged;
}

/**
 * Injected function – runs in page context.
 * Collects info about all <video> and <audio> elements on the page.
 */
function _collectVideoInfo() {
  const results = [];

  document.querySelectorAll('video, audio').forEach((el) => {
    const src = el.currentSrc || el.src;
    if (!src || src.startsWith('blob:')) {
      const sources = Array.from(el.querySelectorAll('source'))
        .map((s) => ({ src: s.src, type: s.type }))
        .filter((s) => s.src && !s.src.startsWith('blob:'));
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
  if (ogVideo && ogVideo.content) {
    results.push({ type: 'og', src: ogVideo.content, title: document.title });
  }

  return results;
}
