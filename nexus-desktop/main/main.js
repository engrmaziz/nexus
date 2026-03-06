'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme, Tray, Menu, nativeImage, protocol } = require('electron');
const path = require('path');
const os = require('os');

const { openDatabase, closeDatabase } = require('./db/database');
const { getStatements } = require('./db/queries');
const downloadManager = require('./engine/downloadManager');
const resumeManager = require('./engine/resumeManager');
const ytdlpInstaller = require('./utils/ytdlpInstaller');
const ytdlpEngine = require('./engine/ytdlpEngine');
const duplicateDetector = require('./ai/duplicateDetector');
const scheduler = require('./ai/scheduler');
const logger = require('./utils/logger');
const { registerGlobalHandlers, initErrorHandlers } = require('./utils/errorHandler');
const server = require('./server');

// ─── App config ──────────────────────────────────────────────────────────────

const IS_DEV = process.env.NODE_ENV === 'development';
const RENDERER = path.join(__dirname, '..', 'renderer', 'index.html');

let mainWindow = null;
let tray = null;

// ─── Single instance lock ─────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    // Handle nexus:// URLs passed to second instance
    const url = commandLine.find((arg) => arg.startsWith('nexus://'));
    if (url) handleNexusUrl(url);
  });
}

// ─── Error handlers ───────────────────────────────────────────────────────────

registerGlobalHandlers();
initErrorHandlers();

// ─── Protocol handler ─────────────────────────────────────────────────────────

app.setAsDefaultProtocolClient('nexus');

if (process.platform === 'darwin') {
  app.on('open-url', (_event, url) => {
    handleNexusUrl(url);
  });
}

function handleNexusUrl(url) {
  try {
    const parsed = new URL(url);
    // nexus://download?url=... – hostname is 'download'
    if (parsed.hostname === 'download') {
      const downloadUrl = parsed.searchParams.get('url');
      if (downloadUrl) {
        downloadManager.add({ url: downloadUrl }).catch((err) =>
          logger.warn('Protocol handler download failed', { err: err.message })
        );
      }
    }
  } catch (err) {
    logger.warn('Invalid nexus:// URL', { url, err: err.message });
  }
}

// ─── App events ───────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Open database & run migrations
  await openDatabase();

  // Seed duplicate detector from completed downloads
  const q = getStatements();
  const completedDls = q.getDownloadsByStatus.all('completed');
  duplicateDetector.seed(completedDls);

  // Ensure yt-dlp is installed
  if (!ytdlpInstaller.isInstalled()) {
    logger.info('yt-dlp not found – installing...');
    ytdlpInstaller.install().catch((err) => logger.warn('yt-dlp install failed', { err: err.message }));
  }

  // Start Express API server (pass the downloadManager instance so server.js
  // uses the same object used by IPC handlers and event listeners here)
  server.startServer(downloadManager);

  createMainWindow();
  createTray();

  // Restore any incomplete downloads
  downloadManager.restoreSession().catch((err) => logger.warn('Session restore error', { err: err.message }));

  // Forward download manager events to renderer
  downloadManager.on('update', (id, changes) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download:update', { id, changes });
    }
  });

  downloadManager.on('progress', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('dl:progress', data);
    }
  });

  downloadManager.on('complete', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('dl:complete', data);
      _updateTrayBadge();
    }
  });

  downloadManager.on('error', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('dl:error', data);
    }
  });

  downloadManager.on('new', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('dl:new', data);
      _updateTrayBadge();
    }
  });

  downloadManager.on('paused', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('dl:paused', data);
      _updateTrayBadge();
    }
  });

  // Handle nexus:// URLs passed at startup (Windows/Linux)
  if (process.platform !== 'darwin') {
    const url = process.argv.find((arg) => arg.startsWith('nexus://'));
    if (url) handleNexusUrl(url);
  }

  // Auto-updater (deferred to avoid blocking startup)
  setTimeout(() => {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.checkForUpdatesAndNotify().catch((err) =>
        logger.debug('Auto-update check failed', { err: err.message })
      );
      autoUpdater.on('update-available', (info) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update:available', info);
        }
      });
      autoUpdater.on('update-downloaded', (info) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update:downloaded', info);
          dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Update ready',
            message: `Nexus ${info.version} is ready to install.`,
            buttons: ['Install now', 'Later'],
          }).then(({ response }) => {
            if (response === 0) autoUpdater.quitAndInstall();
          }).catch(() => {});
        }
      });
    } catch (_) {
      // electron-updater may not be installed in dev; ignore
    }
  }, 3000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on('before-quit', () => {
  closeDatabase();
  server.stop();
});

// ─── Window creation ──────────────────────────────────────────────────────────

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 650,
    frame: false,
    backgroundColor: '#080810',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
    show: false,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
  });

  mainWindow.loadFile(RENDERER);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (IS_DEV) mainWindow.webContents.openDevTools();
  });

  mainWindow.on('close', (e) => {
    try {
      const q = getStatements();
      const setting = q.getSetting.get('minimize_to_tray');
      if (setting?.value === '1') {
        e.preventDefault();
        mainWindow.hide();
      }
    } catch (_) {}
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
  try {
    const icon = nativeImage.createFromPath(iconPath);
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);

    const buildMenu = () => Menu.buildFromTemplate([
      { label: 'Show Window', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
      { type: 'separator' },
      { label: 'Pause All', click: () => { try { downloadManager.pauseAll(); } catch (_) {} } },
      { label: 'Resume All', click: () => { try { downloadManager.resumeAll(); } catch (_) {} } },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]);

    tray.setContextMenu(buildMenu());
    tray.setToolTip('Nexus Download Manager');
    tray.on('double-click', () => {
      if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    });
    tray.on('click', () => {
      if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    });
  } catch (_) {}
}

function _updateTrayBadge() {
  if (!tray) return;
  try {
    const active = downloadManager.getAll
      ? downloadManager.getAll().filter((d) => d.status === 'downloading').length
      : 0;
    tray.setToolTip(`Nexus Download Manager${active > 0 ? ` — ${active} active` : ''}`);
  } catch (_) {}
}

// ─── IPC handlers ────────────────────────────────────────────────────────────

// Window controls (legacy channel names kept for compat)
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());
// New channel names as specified
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window-close', () => mainWindow?.close());

// ── Downloads (legacy channel names) ─────────────────────────────────────────
ipcMain.handle('download:add', async (_e, opts) => {
  return downloadManager.add ? downloadManager.add(opts) : downloadManager.addDownload(opts);
});
ipcMain.handle('download:start', async (_e, id) => {
  if (downloadManager.startDownload) await downloadManager.startDownload(id);
});
ipcMain.handle('download:pause', (_e, id) => {
  if (downloadManager.pauseDownload) downloadManager.pauseDownload(id);
});
ipcMain.handle('download:resume', (_e, id) => {
  if (downloadManager.resumeDownload) downloadManager.resumeDownload(id);
});
ipcMain.handle('download:cancel', (_e, id) => {
  if (downloadManager.cancelDownload) downloadManager.cancelDownload(id);
});
ipcMain.handle('download:delete', (_e, id, deleteFile) => {
  if (downloadManager.deleteDownload) downloadManager.deleteDownload(id, deleteFile);
});
ipcMain.handle('download:getAll', () => {
  return downloadManager.getAll ? downloadManager.getAll() : [];
});
ipcMain.handle('download:getOne', (_e, id) => {
  return downloadManager.getOne ? downloadManager.getOne(id) : null;
});

// ── Downloads (new channel names as specified in the issue) ───────────────────
ipcMain.handle('get-downloads', () => {
  return downloadManager.getAll ? downloadManager.getAll() : [];
});

ipcMain.handle('get-download', (_e, id) => {
  return downloadManager.getOne ? downloadManager.getOne(id) : null;
});

ipcMain.handle('add-download', async (_e, data) => {
  return downloadManager.add ? downloadManager.add(data) : downloadManager.addDownload(data);
});

ipcMain.handle('pause-download', (_e, id) => {
  if (downloadManager.pauseDownload) downloadManager.pauseDownload(id);
});

ipcMain.handle('resume-download', (_e, id) => {
  if (downloadManager.resumeDownload) downloadManager.resumeDownload(id);
});

ipcMain.handle('cancel-download', (_e, id) => {
  if (downloadManager.cancelDownload) downloadManager.cancelDownload(id);
});

ipcMain.handle('retry-download', async (_e, id) => {
  if (downloadManager.retryDownload) return downloadManager.retryDownload(id);
  // Fallback: cancel then re-add from DB
  const q = getStatements();
  const dl = q.getDownload.get(id);
  if (!dl) throw new Error('Download not found');
  if (downloadManager.cancelDownload) downloadManager.cancelDownload(id);
  return downloadManager.add ? downloadManager.add({ url: dl.url }) : null;
});

ipcMain.handle('remove-download', (_e, id) => {
  if (downloadManager.deleteDownload) downloadManager.deleteDownload(id, false);
});

ipcMain.handle('pause-all', () => {
  if (downloadManager.pauseAll) downloadManager.pauseAll();
});

ipcMain.handle('resume-all', () => {
  if (downloadManager.resumeAll) downloadManager.resumeAll();
});

ipcMain.handle('get-playlist-info', async (_e, url) => {
  return ytdlpEngine.getPlaylistInfo(url);
});

ipcMain.handle('download-playlist', async (_e, data) => {
  const { url, quality, title, entries } = data;
  if (Array.isArray(entries) && entries.length > 0) {
    const ids = [];
    for (const entry of entries) {
      const id = await (downloadManager.add || downloadManager.addDownload).call(
        downloadManager,
        { url: entry.url || url, quality, title: entry.title }
      );
      ids.push(id);
    }
    return { success: true, count: ids.length, ids };
  }
  // No entries – treat as single download
  return downloadManager.add ? downloadManager.add({ url, quality, title }) : null;
});

ipcMain.handle('get-video-formats', async (_e, url) => {
  return ytdlpEngine.getAvailableFormats(url);
});

// ── Settings ──────────────────────────────────────────────────────────────────
ipcMain.handle('settings:get', (_e, key) => {
  try {
    const q = getStatements();
    const row = q.getSetting.get(key);
    return row ? row.value : null;
  } catch (_) { return null; }
});
ipcMain.handle('settings:set', (_e, key, value) => {
  try {
    const q = getStatements();
    q.setSetting.run({ key, value: String(value) });
    return true;
  } catch (_) { return false; }
});
ipcMain.handle('settings:getAll', () => {
  try {
    const q = getStatements();
    const rows = q.getAllSettings.all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch (_) { return {}; }
});

ipcMain.handle('get-settings', () => {
  try {
    const q = getStatements();
    const rows = q.getAllSettings.all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch (_) { return {}; }
});

ipcMain.handle('set-setting', (_e, key, value) => {
  try {
    const q = getStatements();
    q.setSetting.run({ key, value: String(value) });
    return true;
  } catch (_) { return false; }
});

// ── Stats ─────────────────────────────────────────────────────────────────────
ipcMain.handle('stats:get', () => {
  try {
    const q = getStatements();
    return { history: q.getStats.all(), totals: q.getTotalStats.get() };
  } catch (_) { return { history: [], totals: {} }; }
});

ipcMain.handle('get-stats', () => {
  try {
    const q = getStatements();
    return { history: q.getStats.all(), totals: q.getTotalStats.get() };
  } catch (_) { return { history: [], totals: {} }; }
});

// ── Shell / Dialog ─────────────────────────────────────────────────────────────
ipcMain.handle('shell:openFile', (_e, filePath) => {
  shell.openPath(filePath);
});
ipcMain.handle('shell:showInFolder', (_e, filePath) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle('open-file', (_e, filePath) => shell.openPath(filePath));
ipcMain.handle('open-folder', (_e, filePath) => shell.showItemInFolder(filePath));

ipcMain.handle('dialog:selectFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('browse-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

// ── yt-dlp installer ──────────────────────────────────────────────────────────
ipcMain.handle('ytdlp:check', async () => {
  return ytdlpInstaller.checkUpdate();
});
ipcMain.handle('ytdlp:install', async () => {
  return ytdlpInstaller.install({
    onProgress: (p) => mainWindow?.webContents.send('ytdlp:installProgress', p),
  });
});

ipcMain.handle('check-ytdlp', async () => ytdlpEngine.ytdlpInstalled());
ipcMain.handle('install-ytdlp', async () => ytdlpEngine.installYtdlp({
  onProgress: (p) => mainWindow?.webContents.send('ytdlp:installProgress', p),
}));

// ── AI Scheduler ───────────────────────────────────────────────────────────────
ipcMain.handle('get-ai-schedule', async () => {
  try {
    return scheduler.getScheduleData ? scheduler.getScheduleData() : {};
  } catch (_) { return {}; }
});
