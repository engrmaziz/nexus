'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Expose a safe, typed API to the renderer process via contextBridge.
 * Never expose ipcRenderer directly.
 */

// ─── Window controls ──────────────────────────────────────────────────────────
const windowAPI = {
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close:    () => ipcRenderer.send('window:close'),
};

// ─── Downloads ────────────────────────────────────────────────────────────────
const downloadAPI = {
  add:       (opts)             => ipcRenderer.invoke('download:add', opts),
  start:     (id)               => ipcRenderer.invoke('download:start', id),
  pause:     (id)               => ipcRenderer.invoke('download:pause', id),
  resume:    (id)               => ipcRenderer.invoke('download:resume', id),
  cancel:    (id)               => ipcRenderer.invoke('download:cancel', id),
  delete:    (id, deleteFile)   => ipcRenderer.invoke('download:delete', id, deleteFile),
  getAll:    ()                 => ipcRenderer.invoke('download:getAll'),
  getOne:    (id)               => ipcRenderer.invoke('download:getOne', id),

  /** Subscribe to live download update events. Returns an unsubscribe function. */
  onUpdate: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('download:update', handler);
    return () => ipcRenderer.removeListener('download:update', handler);
  },
};

// ─── Shell ───────────────────────────────────────────────────────────────────
const shellAPI = {
  openFile:      (p) => ipcRenderer.invoke('shell:openFile', p),
  showInFolder:  (p) => ipcRenderer.invoke('shell:showInFolder', p),
};

// ─── Dialog ──────────────────────────────────────────────────────────────────
const dialogAPI = {
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
};

// ─── Settings ────────────────────────────────────────────────────────────────
const settingsAPI = {
  get:    (key)         => ipcRenderer.invoke('settings:get', key),
  set:    (key, value)  => ipcRenderer.invoke('settings:set', key, value),
  getAll: ()            => ipcRenderer.invoke('settings:getAll'),
};

// ─── Stats ───────────────────────────────────────────────────────────────────
const statsAPI = {
  get: () => ipcRenderer.invoke('stats:get'),
};

// ─── yt-dlp installer ────────────────────────────────────────────────────────
const ytdlpAPI = {
  check:   ()  => ipcRenderer.invoke('ytdlp:check'),
  install: ()  => ipcRenderer.invoke('ytdlp:install'),

  onInstallProgress: (cb) => {
    const handler = (_event, percent) => cb(percent);
    ipcRenderer.on('ytdlp:installProgress', handler);
    return () => ipcRenderer.removeListener('ytdlp:installProgress', handler);
  },
};

// ─── Expose window.nexus (used by renderer components) ───────────────────────
contextBridge.exposeInMainWorld('nexus', {
  window:   windowAPI,
  download: downloadAPI,
  shell:    shellAPI,
  dialog:   dialogAPI,
  settings: settingsAPI,
  stats:    statsAPI,
  ytdlp:    ytdlpAPI,
  version:  process.env.npm_package_version || '1.0.0',
  platform: process.platform,
});

// ─── Expose window.electron (Chrome-extension bridge API) ────────────────────
contextBridge.exposeInMainWorld('electron', {
  // Downloads
  getDownloads:     ()       => ipcRenderer.invoke('get-downloads'),
  getDownload:      (id)     => ipcRenderer.invoke('get-download', id),
  addDownload:      (data)   => ipcRenderer.invoke('add-download', data),
  pauseDownload:    (id)     => ipcRenderer.invoke('pause-download', id),
  resumeDownload:   (id)     => ipcRenderer.invoke('resume-download', id),
  cancelDownload:   (id)     => ipcRenderer.invoke('cancel-download', id),
  retryDownload:    (id)     => ipcRenderer.invoke('retry-download', id),
  removeDownload:   (id)     => ipcRenderer.invoke('remove-download', id),
  pauseAll:         ()       => ipcRenderer.invoke('pause-all'),
  resumeAll:        ()       => ipcRenderer.invoke('resume-all'),

  // Playlist / formats
  getPlaylistInfo:  (url)    => ipcRenderer.invoke('get-playlist-info', url),
  downloadPlaylist: (data)   => ipcRenderer.invoke('download-playlist', data),
  getVideoFormats:  (url)    => ipcRenderer.invoke('get-video-formats', url),

  // Settings
  getSettings:      ()           => ipcRenderer.invoke('get-settings'),
  setSetting:       (key, val)   => ipcRenderer.invoke('set-setting', key, val),

  // Stats
  getStats:         ()       => ipcRenderer.invoke('get-stats'),

  // Shell / dialog
  browseFolder:     ()       => ipcRenderer.invoke('browse-folder'),
  openFile:         (path)   => ipcRenderer.invoke('open-file', path),
  openFolder:       (path)   => ipcRenderer.invoke('open-folder', path),

  // yt-dlp
  checkYtdlp:       ()       => ipcRenderer.invoke('check-ytdlp'),
  installYtdlp:     ()       => ipcRenderer.invoke('install-ytdlp'),

  // AI Scheduler
  getAiSchedule:    ()       => ipcRenderer.invoke('get-ai-schedule'),

  // Event listeners for download state changes
  onProgress: (cb) => ipcRenderer.on('dl:progress', (_event, d) => cb(d)),
  onComplete: (cb) => ipcRenderer.on('dl:complete', (_event, d) => cb(d)),
  onError:    (cb) => ipcRenderer.on('dl:error',    (_event, d) => cb(d)),
  onNew:      (cb) => ipcRenderer.on('dl:new',      (_event, d) => cb(d)),
  onPaused:   (cb) => ipcRenderer.on('dl:paused',   (_event, d) => cb(d)),

  removeAllListeners: (ch) => ipcRenderer.removeAllListeners(ch),

  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close:    () => ipcRenderer.send('window-close'),
});
