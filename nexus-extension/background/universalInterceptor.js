// nexus-extension/background/universalInterceptor.js
// Monitors all web requests and flags potential download URLs.

const DOWNLOAD_MIME_TYPES = new Set([
  'application/octet-stream',
  'application/zip',
  'application/x-tar',
  'application/gzip',
  'application/x-rar-compressed',
  'application/x-7z-compressed',
  'application/pdf',
  'video/mp4', 'video/webm', 'video/x-matroska', 'video/x-flv',
  'audio/mpeg', 'audio/aac', 'audio/flac', 'audio/ogg',
  'application/x-bittorrent',
]);

const DOWNLOAD_EXTENSIONS = /\.(zip|tar|gz|bz2|7z|rar|exe|msi|dmg|deb|rpm|apk|mp4|mkv|avi|mov|flv|webm|mp3|flac|aac|ogg|wav|pdf|iso)(\?.*)?$/i;

// Threshold in bytes – responses larger than this may be download candidates
const LARGE_THRESHOLD = 5 * 1024 * 1024; // 5 MB

// Map of requestId -> { url, tabId }
const pendingRequests = new Map();

export const universalInterceptor = {
  init() {
    // Track request headers (to capture referrer etc.)
    chrome.webRequest.onBeforeSendHeaders.addListener(
      (details) => {
        pendingRequests.set(details.requestId, {
          url: details.url,
          tabId: details.tabId,
          initiator: details.initiator,
        });
      },
      { urls: ['<all_urls>'] },
      ['requestHeaders']
    );

    // Inspect response headers for download signals
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

        const isDownload =
          contentDisp.toLowerCase().includes('attachment') ||
          DOWNLOAD_MIME_TYPES.has(contentType.split(';')[0].trim()) ||
          DOWNLOAD_EXTENSIONS.test(pending.url) ||
          (contentLen > LARGE_THRESHOLD && contentType.startsWith('application/'));

        if (isDownload) {
          // Notify content script / popup
          chrome.tabs.sendMessage(pending.tabId, {
            type: 'DOWNLOAD_DETECTED',
            url: pending.url,
            contentType,
            contentDisposition: contentDisp,
            size: contentLen,
          }).catch(() => {}); // ignore if no content script
        }

        pendingRequests.delete(details.requestId);
      },
      { urls: ['<all_urls>'] },
      ['responseHeaders']
    );

    // Cleanup on error/abort
    chrome.webRequest.onErrorOccurred.addListener(
      (details) => pendingRequests.delete(details.requestId),
      { urls: ['<all_urls>'] }
    );

    chrome.webRequest.onCompleted.addListener(
      (details) => pendingRequests.delete(details.requestId),
      { urls: ['<all_urls>'] }
    );
  },
};
