// nexus-extension/background/background.js
// Service worker entry point (MV3)

import { universalInterceptor } from './universalInterceptor.js';
import { videoDetector } from './videoDetector.js';
import { playlistDetector } from './playlistDetector.js';
import { desktopBridge } from './desktopBridge.js';
import { analyzeHLS, analyzeDASH, analyzeMP4, analyzeUrlFull } from './streamAnalyzer.js';

// ─── Install / startup ───────────────────────────────────────────────────────

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Initialize modules
universalInterceptor.init();
videoDetector.init();
desktopBridge.init().catch(() => {}); // Non-fatal if desktop not running at startup

// ─── Context menus ────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'nexus-download-link',
      title: 'Download with Nexus',
      contexts: ['link'],
    });
    chrome.contextMenus.create({
      id: 'nexus-download-video',
      title: 'Download Video with Nexus',
      contexts: ['video', 'audio'],
    });
    chrome.contextMenus.create({
      id: 'nexus-download-image',
      title: 'Download Image with Nexus',
      contexts: ['image'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.linkUrl || info.srcUrl || info.frameUrl;
  if (!url) return;
  desktopBridge.sendDownload({ url, referrer: tab?.url }).then(() => {
    showNotification('Download Added', url.slice(0, 80));
  }).catch((err) => {
    showNotification('Nexus Error', err.message, 'error');
  });
});

// ─── Message routing from content scripts ────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse).catch((err) => {
    sendResponse({ error: err.message });
  });
  return true; // keep channel open for async response
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'DOWNLOAD_URL': {
      try {
        await desktopBridge.sendDownload({
          url:       msg.url,
          referrer:  sender.url,
          headers:   msg.headers,
          quality:   msg.quality,
          filename:  msg.filename,
          pageTitle: msg.pageTitle || '',
          pageUrl:   msg.pageUrl   || sender.url || '',
        });
        showNotification('Download Added', (msg.url || '').slice(0, 80));
        return { ok: true };
      } catch (err) {
        // Edge case [10]: Desktop app not running – notify user and let browser handle it
        if (err.message && err.message.includes('not running')) {
          chrome.notifications.create(`nexus-app-offline-${Date.now()}`, {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon48.png'),
            title: 'Nexus is not running',
            message: 'Nexus app is not running. Download will proceed normally in browser.',
            priority: 1,
          });
          // Track missed download in storage so the app can surface it on next startup
          chrome.storage.local.get(['missedDownloads'], (result) => {
            const missed = result.missedDownloads || [];
            missed.push({ url: msg.url, timestamp: Date.now() });
            chrome.storage.local.set({ missedDownloads: missed });
          });
          return { ok: false, fallback: true };
        }
        throw err;
      }
    }

    case 'DOWNLOAD_PLAYLIST':
      await desktopBridge.sendPlaylist({
        url: msg.url,
        type: msg.playlistType || 'unknown',
        id: msg.playlistId || '',
        quality: msg.quality,
      });
      showNotification('Playlist Added', (msg.url || '').slice(0, 80));
      return { ok: true };

    case 'DETECT_VIDEO':
      return videoDetector.detectFromTab(msg.tabId || sender.tab?.id);

    case 'GET_STREAMS': {
      const tabId = msg.tabId || sender.tab?.id;
      const streams = videoDetector.getStreams(tabId);
      return { streams };
    }

    case 'ANALYZE_STREAM': {
      if (!msg.url) return { error: 'No URL provided' };
      return analyzeUrlFull(msg.url);
    }

    case 'ANALYZE_HLS':
      if (!msg.url) return { error: 'No URL provided' };
      return analyzeHLS(msg.url);

    case 'ANALYZE_DASH':
      if (!msg.url) return { error: 'No URL provided' };
      return analyzeDASH(msg.url);

    case 'ANALYZE_MP4':
      if (!msg.url) return { error: 'No URL provided' };
      return analyzeMP4(msg.url);

    case 'DETECT_PLAYLIST':
      return playlistDetector.detect(msg.url || sender.url);

    case 'GET_NEXUS_STATUS':
      return desktopBridge.ping();

    case 'OPEN_APP': {
      const connected = await desktopBridge.isConnected();
      const port = await desktopBridge.getPort();
      const nexusBaseUrl = `http://127.0.0.1:${port || 6543}`;
      const tabs = await chrome.tabs.query({});
      const nexusTab = tabs.find((t) => t.url && t.url.startsWith(nexusBaseUrl));
      if (nexusTab) {
        await chrome.tabs.update(nexusTab.id, { active: true });
        await chrome.windows.update(nexusTab.windowId, { focused: true });
      } else {
        await chrome.tabs.create({ url: nexusBaseUrl });
      }
      return { ok: true };
    }

    default:
      return { error: 'Unknown message type' };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function showNotification(title, message, type = 'success') {
  chrome.notifications.create(`nexus-${Date.now()}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon48.png'),
    title,
    message: message || '',
    priority: type === 'error' ? 2 : 0,
  });
}
