// nexus-extension/background/universalInterceptor.js
// Intercepts ALL downloadable files and routes them through the Nexus desktop app.

import { desktopBridge } from './desktopBridge.js';

const DOWNLOAD_MIME_TYPES = new Set([
  'application/octet-stream',
  'application/zip',
  'application/x-tar',
  'application/gzip',
  'application/x-rar-compressed',
  'application/x-7z-compressed',
  'application/x-bzip2',
  'application/x-xz',
  'application/pdf',
  'application/vnd.android.package-archive',
  'application/x-iso9660-image',
  'application/x-msdownload',
  'application/x-msi',
  'video/mp4', 'video/webm', 'video/x-matroska', 'video/x-flv',
  'video/quicktime', 'video/x-msvideo', 'video/mpeg',
  'audio/mpeg', 'audio/aac', 'audio/flac', 'audio/ogg',
  'audio/wav', 'audio/x-wav', 'audio/mp4',
  'application/x-bittorrent',
]);

const DOWNLOAD_EXTENSIONS = /\.(zip|tar|gz|bz2|7z|rar|exe|msi|dmg|deb|rpm|apk|mp4|mkv|avi|mov|flv|webm|mp3|flac|aac|ogg|wav|pdf|iso)(\?.*)?$/i;

// Only intercept files larger than this threshold (512 KB per issue spec — avoids
// intercepting small inline resources like favicons, tiny images, API responses)
const SIZE_THRESHOLD = 512 * 1024; // 512 KB

// Map of requestId -> { url, tabId, referrer }
const pendingRequests = new Map();

// Set of requestIds we are actively intercepting (to cancel the browser download)
const interceptedRequests = new Set();

export const universalInterceptor = {
  init() {
    // Phase 1: Record outgoing requests so we have their metadata when headers arrive
    chrome.webRequest.onBeforeSendHeaders.addListener(
      (details) => {
        pendingRequests.set(details.requestId, {
          url: details.url,
          tabId: details.tabId,
          referrer: details.initiator || '',
        });
      },
      { urls: ['<all_urls>'] },
      ['requestHeaders']
    );

    // Phase 2: Inspect response headers; decide whether to intercept
    chrome.webRequest.onHeadersReceived.addListener(
      (details) => {
        const pending = pendingRequests.get(details.requestId);
        if (!pending) return;

        const headers = {};
        for (const h of (details.responseHeaders || [])) {
          headers[h.name.toLowerCase()] = h.value;
        }

        const contentType = headers['content-type'] || '';
        const contentDisp = headers['content-disposition'] || '';
        const contentLen  = parseInt(headers['content-length'] || '0', 10);

        const mimeBase = contentType.split(';')[0].trim().toLowerCase();
        const isAttachment = contentDisp.toLowerCase().includes('attachment');
        const isKnownMime  = DOWNLOAD_MIME_TYPES.has(mimeBase);
        const isKnownExt   = DOWNLOAD_EXTENSIONS.test(pending.url);

        // Must exceed size threshold (if Content-Length is known)
        const meetsThreshold = contentLen === 0 || contentLen > SIZE_THRESHOLD;

        if ((isAttachment || isKnownMime || isKnownExt) && meetsThreshold) {
          interceptedRequests.add(details.requestId);

          // Attempt to route through Nexus desktop; cancel the browser download
          _routeToDesktop(pending.url, pending.referrer, contentType, contentLen, pending.tabId);
        }

        pendingRequests.delete(details.requestId);
      },
      { urls: ['<all_urls>'] },
      ['responseHeaders']
    );

    // Cleanup stale entries
    chrome.webRequest.onErrorOccurred.addListener(
      (details) => {
        pendingRequests.delete(details.requestId);
        interceptedRequests.delete(details.requestId);
      },
      { urls: ['<all_urls>'] }
    );

    chrome.webRequest.onCompleted.addListener(
      (details) => {
        pendingRequests.delete(details.requestId);
        interceptedRequests.delete(details.requestId);
      },
      { urls: ['<all_urls>'] }
    );

    // Cancel browser-initiated downloads that we already routed to Nexus.
    // _recentInterceptions is a Set<url> populated by _routeToDesktop().
    chrome.downloads.onCreated.addListener((downloadItem) => {
      const url = downloadItem.url;
      if (!url) return;
      if (_recentInterceptions.has(url)) {
        chrome.downloads.cancel(downloadItem.id);
        _recentInterceptions.delete(url);
      }
    });
  },
};

// Short-lived set of URLs we sent to desktop, so downloads.onCreated can cancel them
const _recentInterceptions = new Set();

async function _routeToDesktop(url, referrer, contentType, size, tabId) {
  const sent = await desktopBridge.sendDownload({ url, referrer, contentType, size })
    .then(() => true)
    .catch(() => false);

  if (sent) {
    _recentInterceptions.add(url);
    // Remove from set after 5 seconds to avoid stale entries
    setTimeout(() => _recentInterceptions.delete(url), 5000);

    // Notify the tab
    if (tabId && tabId > 0) {
      chrome.tabs.sendMessage(tabId, {
        type: 'DOWNLOAD_INTERCEPTED',
        url,
        contentType,
        size,
      }).catch(() => {});
    }
  } else {
    // Fallback: desktop not running – let the browser handle the download normally
    if (tabId && tabId > 0) {
      chrome.tabs.sendMessage(tabId, {
        type: 'DOWNLOAD_DETECTED',
        url,
        contentType,
        size,
      }).catch(() => {});
    }
  }
}
