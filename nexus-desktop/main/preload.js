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

// ─── Expose ──────────────────────────────────────────────────────────────────
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
