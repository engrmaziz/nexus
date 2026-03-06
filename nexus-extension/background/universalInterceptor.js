// nexus-extension/background/universalInterceptor.js
// Intercepts downloadable files and routes them through the Nexus desktop app.
// Uses chrome.downloads.onCreated as the primary MV3-compatible interception method.
// webRequest is used as a secondary helper to collect metadata (content-type, size).

import { desktopBridge } from './desktopBridge.js';

// ─── Skip lists ───────────────────────────────────────────────────────────────

// Never intercept requests from these domains (search engines, CDNs, ad networks, etc.)
const SKIP_DOMAINS = [
  'google.com', 'googleapis.com', 'gstatic.com',
  'googlevideo.com',           // YouTube video CDN – handled by yt-dlp instead
  'doubleclick.net', 'googleadservices.com',
  'facebook.com', 'fbcdn.net',
  'twitter.com', 'twimg.com',
  'amazon.com', 'amazonaws.com',
  'cloudflare.com',
  '127.0.0.1', 'localhost',
];

// Never intercept URLs whose path contains these segments (API / search endpoints)
const SKIP_PATH_SEGMENTS = [
  '/complete/', '/search', '/api/', '/graphql',
  '/xhr/', '/json', '/ajax', '/httpservice/',
];

// Never intercept files with these extensions (web assets, scripts, data)
const SKIP_EXTENSIONS = new Set([
  '.html', '.htm', '.php', '.asp', '.aspx', '.jsp',
  '.css', '.js', '.mjs', '.ts',
  '.json', '.xml', '.svg', '.woff', '.woff2', '.ttf',
  '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.ico', '.map',
]);

// Never intercept responses with these MIME types (non-binary content)
const SKIP_MIME_PREFIXES = ['text/', 'application/json', 'application/xml',
  'application/javascript', 'application/x-www-form-urlencoded'];

// Positive indicators: MIME types we ALWAYS treat as downloads
const BINARY_MIME_TYPES = new Set([
  'application/zip', 'application/x-zip', 'application/x-zip-compressed',
  'application/x-7z-compressed', 'application/x-rar-compressed',
  'application/x-tar', 'application/gzip', 'application/x-bzip2', 'application/x-xz',
  'application/x-iso9660-image', 'application/x-msdownload', 'application/x-msi',
  'application/x-executable', 'application/vnd.android.package-archive',
  'application/pdf', 'application/x-bittorrent', 'application/octet-stream',
  'application/vnd.apple.mpegurl', 'application/dash+xml', 'application/x-torrent',
]);

// Positive indicators: file extensions we treat as downloads
const DOWNLOAD_EXTENSIONS = new Set([
  '.zip', '.7z', '.rar', '.tar', '.gz', '.bz2', '.xz', '.zst',
  '.iso', '.img', '.dmg', '.exe', '.msi', '.deb', '.rpm', '.pkg', '.apk', '.ipa',
  '.pdf', '.mp3', '.flac', '.wav', '.ogg', '.aac', '.m4a',
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m3u8', '.mpd', '.torrent',
]);

// Minimum file size to intercept (1 MB)
const SIZE_THRESHOLD = 1024 * 1024;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _getHostname(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ''; }
}

function _getPathname(url) {
  try { return new URL(url).pathname.toLowerCase(); } catch (_) { return ''; }
}

function _getExtension(url) {
  try {
    const p = new URL(url).pathname;
    const dot = p.lastIndexOf('.');
    return dot !== -1 ? p.slice(dot).toLowerCase() : '';
  } catch (_) { return ''; }
}

function _isSkipDomain(url) {
  const host = _getHostname(url);
  return SKIP_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
}

function _isSkipPath(url) {
  const pathname = _getPathname(url);
  return SKIP_PATH_SEGMENTS.some((seg) => pathname.includes(seg));
}

function _isSkipMime(mime) {
  if (!mime) return false;
  const base = mime.split(';')[0].trim().toLowerCase();
  return SKIP_MIME_PREFIXES.some((p) => base.startsWith(p));
}

/**
 * Decide whether Nexus should handle this download.
 *
 * @param {string} url
 * @param {string} filename   Suggested local filename (may be empty).
 * @param {number} fileSize   Known file size in bytes, 0 if unknown.
 * @param {string} mime       MIME type reported by the server (may be empty).
 * @returns {boolean}
 */
export function shouldNexusHandle(url, filename, fileSize, mime) {
  if (!url) return false;

  // Hard skip by domain
  if (_isSkipDomain(url)) return false;

  // Hard skip by path segment (API / search endpoints)
  if (_isSkipPath(url)) return false;

  // Derive extension from URL first, fall back to filename
  const urlExt  = _getExtension(url);
  // Only extract a file extension from filename if the filename actually contains a dot
  const dotIdx  = filename ? filename.lastIndexOf('.') : -1;
  const fileExt = dotIdx > 0 ? filename.slice(dotIdx).toLowerCase() : '';
  const ext     = urlExt || fileExt;

  // Hard skip for web-asset extensions
  if (ext && SKIP_EXTENSIONS.has(ext)) return false;

  // Hard skip for non-binary MIME types
  if (_isSkipMime(mime)) return false;

  // Hard skip files smaller than 1 MB (if size is known)
  const size = fileSize > 0 ? fileSize : 0;
  if (size > 0 && size < SIZE_THRESHOLD) return false;

  // Positive check: known binary MIME or known download extension
  const mimeBase = mime ? mime.split(';')[0].trim().toLowerCase() : '';
  const hasBinaryMime = (
    BINARY_MIME_TYPES.has(mimeBase) ||
    mimeBase.startsWith('audio/') ||
    mimeBase.startsWith('video/')
  );
  const hasDownloadExt = ext ? DOWNLOAD_EXTENSIONS.has(ext) : false;

  return hasBinaryMime || hasDownloadExt;
}

// ─── State ────────────────────────────────────────────────────────────────────

// Map of URL → { mimeType, fileSize, tabId, referrer } collected from webRequest
const _requestMeta = new Map();

// URLs we have re-allowed (desktop not running) to avoid re-intercepting them
const _reallowedUrls = new Set();

// ─── Main export ──────────────────────────────────────────────────────────────

export const universalInterceptor = {
  init() {
    // ── PRIMARY: chrome.downloads.onCreated ────────────────────────────────
    // This is the correct MV3 approach. Every time Chrome starts a download
    // we decide whether Nexus should handle it, cancel the browser download if
    // so, and send it to the desktop app.
    chrome.downloads.onCreated.addListener(async (item) => {
      const url = item.url;
      if (!url) return;

      // Skip URLs we explicitly re-allowed (desktop not running fallback)
      if (_reallowedUrls.has(url)) {
        _reallowedUrls.delete(url);
        return;
      }

      // Merge webRequest metadata (may have arrived before onCreated fires)
      const meta    = _requestMeta.get(url) || {};
      const mime    = item.mime || meta.mimeType || '';
      const size    = (item.fileSize > 0 ? item.fileSize : 0) || meta.fileSize || 0;
      const tabId   = item.tabId > 0 ? item.tabId : (meta.tabId || -1);
      const referrer = meta.referrer || '';

      if (!shouldNexusHandle(url, item.filename || '', size, mime)) return;

      // Cancel the browser download immediately
      chrome.downloads.cancel(item.id);
      setTimeout(() => chrome.downloads.erase({ id: item.id }), 1000);

      // Get page title from the originating tab (best-effort)
      let pageTitle = '';
      if (tabId > 0) {
        try {
          const tab = await chrome.tabs.get(tabId);
          pageTitle = tab.title || '';
        } catch (_) {}
      }

      // Send to Nexus desktop
      const sent = await desktopBridge.sendDownload({
        url,
        filename: item.filename || '',
        fileSize: size,
        mimeType: mime,
        referrer,
        pageTitle,
        type: 'file',
      }).then(() => true).catch(() => false);

      if (sent) {
        // Notify the originating tab
        if (tabId > 0) {
          chrome.tabs.sendMessage(tabId, {
            type: 'DOWNLOAD_INTERCEPTED',
            url,
            contentType: mime,
            size,
          }).catch(() => {});
        }
      } else {
        // Desktop not running – re-allow the browser to handle this download
        _reallowedUrls.add(url);
        setTimeout(() => _reallowedUrls.delete(url), 5000);
        chrome.downloads.download({
          url,
          filename: item.filename || undefined,
        }).catch(() => {});

        if (tabId > 0) {
          chrome.tabs.sendMessage(tabId, {
            type: 'DOWNLOAD_DETECTED',
            url,
            contentType: mime,
            size,
          }).catch(() => {});
        }
      }

      // Clean up metadata entry
      _requestMeta.delete(url);
    });

    // ── SECONDARY: webRequest – collect metadata only (no blocking in MV3) ──
    // This enriches the metadata used by the onCreated handler above.
    chrome.webRequest.onBeforeSendHeaders.addListener(
      (details) => {
        if (_isSkipDomain(details.url)) return;
        _requestMeta.set(details.url, {
          tabId:    details.tabId,
          referrer: details.initiator || '',
          mimeType: '',
          fileSize: 0,
        });
      },
      { urls: ['<all_urls>'] },
      ['requestHeaders']
    );

    chrome.webRequest.onHeadersReceived.addListener(
      (details) => {
        const meta = _requestMeta.get(details.url);
        if (!meta) return;

        const headers = {};
        for (const h of (details.responseHeaders || [])) {
          headers[h.name.toLowerCase()] = h.value;
        }

        meta.mimeType = (headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        meta.fileSize = parseInt(headers['content-length'] || '0', 10) || 0;
      },
      { urls: ['<all_urls>'] },
      ['responseHeaders']
    );

    // Clean up stale metadata entries
    chrome.webRequest.onErrorOccurred.addListener(
      (details) => { _requestMeta.delete(details.url); },
      { urls: ['<all_urls>'] }
    );

    chrome.webRequest.onCompleted.addListener(
      (details) => {
        // Only remove if we haven't already consumed the entry in onCreated
        setTimeout(() => _requestMeta.delete(details.url), 10000);
      },
      { urls: ['<all_urls>'] }
    );
  },
};
