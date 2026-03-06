// nexus-extension/background/background.js
// Service worker entry point (MV3)

import { universalInterceptor } from './universalInterceptor.js';
import { videoDetector } from './videoDetector.js';
import { playlistDetector } from './playlistDetector.js';
import { desktopBridge } from './desktopBridge.js';

// ─── Install / startup ───────────────────────────────────────────────────────

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

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
    case 'DOWNLOAD_URL':
      await desktopBridge.sendDownload({ url: msg.url, referrer: sender.url, headers: msg.headers });
      showNotification('Download Added', (msg.url || '').slice(0, 80));
      return { ok: true };

    case 'DETECT_VIDEO':
      return videoDetector.detectFromTab(msg.tabId || sender.tab?.id);

    case 'DETECT_PLAYLIST':
      return playlistDetector.detect(msg.url || sender.url);

    case 'GET_NEXUS_STATUS':
      return desktopBridge.ping();

    default:
      return { error: 'Unknown message type' };
  }
}

// ─── Web request interception ─────────────────────────────────────────────────

universalInterceptor.init();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function showNotification(title, message, type = 'success') {
  chrome.notifications.create(`nexus-${Date.now()}`, {
    type: 'basic',
    iconUrl: '../icons/icon48.png',
    title,
    message: message || '',
    priority: type === 'error' ? 2 : 0,
  });
}
