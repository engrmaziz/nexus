'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme, Tray, Menu } = require('electron');
const path = require('path');
const os = require('os');

const { openDatabase, closeDatabase } = require('./db/database');
const { getStatements } = require('./db/queries');
const downloadManager = require('./engine/downloadManager');
const resumeManager = require('./engine/resumeManager');
const ytdlpInstaller = require('./utils/ytdlpInstaller');
const duplicateDetector = require('./ai/duplicateDetector');
const logger = require('./utils/logger');
const { registerGlobalHandlers } = require('./utils/errorHandler');
const server = require('./server');

// ─── App config ──────────────────────────────────────────────────────────────

const IS_DEV = process.env.NODE_ENV === 'development';
const RENDERER = path.join(__dirname, '..', 'renderer', 'index.html');

let mainWindow = null;
let tray = null;

// ─── Error handlers ───────────────────────────────────────────────────────────

registerGlobalHandlers();

// ─── App events ───────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Open database & run migrations
  openDatabase();

  // Seed duplicate detector from completed downloads
  const q = getStatements();
  const completedDls = q.getDownloadsByStatus.all('completed');
  duplicateDetector.seed(completedDls);

  // Ensure yt-dlp is installed
  if (!ytdlpInstaller.isInstalled()) {
    logger.info('yt-dlp not found – installing...');
    ytdlpInstaller.install().catch((err) => logger.warn('yt-dlp install failed', { err: err.message }));
  }

  // Start Express API server
  server.start();

  createMainWindow();
  createTray();

  // Restore any incomplete downloads
  downloadManager.restoreSession().catch((err) => logger.warn('Session restore error', { err: err.message }));

  // Forward download updates to renderer
  downloadManager.on('update', (id, changes) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download:update', { id, changes });
    }
  });
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
    width: 1200,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a2e' : '#ffffff',
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
    const q = getStatements();
    const setting = q.getSetting.get('minimize_to_tray');
    if (setting?.value === '1') {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
  // Silently skip if icon file doesn't exist during dev
  try {
    tray = new Tray(iconPath);
    const menu = Menu.buildFromTemplate([
      { label: 'Open Nexus', click: () => mainWindow?.show() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]);
    tray.setContextMenu(menu);
    tray.setToolTip('Nexus Download Manager');
    tray.on('click', () => mainWindow?.show());
  } catch (_) {}
}

// ─── IPC handlers ────────────────────────────────────────────────────────────

// Window controls
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());

// Downloads
ipcMain.handle('download:add', async (_e, opts) => {
  return downloadManager.addDownload(opts);
});
ipcMain.handle('download:start', async (_e, id) => {
  await downloadManager.startDownload(id);
});
ipcMain.handle('download:pause', (_e, id) => {
  downloadManager.pauseDownload(id);
});
ipcMain.handle('download:resume', (_e, id) => {
  downloadManager.resumeDownload(id);
});
ipcMain.handle('download:cancel', (_e, id) => {
  downloadManager.cancelDownload(id);
});
ipcMain.handle('download:delete', (_e, id, deleteFile) => {
  downloadManager.deleteDownload(id, deleteFile);
});
ipcMain.handle('download:getAll', () => {
  return downloadManager.getAll();
});
ipcMain.handle('download:getOne', (_e, id) => {
  return downloadManager.getOne(id);
});

// Open file/folder
ipcMain.handle('shell:openFile', (_e, filePath) => {
  shell.openPath(filePath);
});
ipcMain.handle('shell:showInFolder', (_e, filePath) => {
  shell.showItemInFolder(filePath);
});

// Folder picker
ipcMain.handle('dialog:selectFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

// Settings
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

// Stats
ipcMain.handle('stats:get', () => {
  try {
    const q = getStatements();
    return { history: q.getStats.all(), totals: q.getTotalStats.get() };
  } catch (_) { return { history: [], totals: {} }; }
});

// yt-dlp installer
ipcMain.handle('ytdlp:check', async () => {
  return ytdlpInstaller.checkUpdate();
});
ipcMain.handle('ytdlp:install', async () => {
  return ytdlpInstaller.install({
    onProgress: (p) => mainWindow?.webContents.send('ytdlp:installProgress', p),
  });
});
