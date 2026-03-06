'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');

const { getStatements } = require('../db/queries');
const { downloadWithChunks } = require('./chunkEngine');
const ChunkEngine = require('./chunkEngine');
const YtdlpEngine = require('./ytdlpEngine');
const HlsEngine = require('./hlsEngine');
const DashEngine = require('./dashEngine');
const SpeedTracker = require('./speedTracker');
const resumeManager = require('./resumeManager');
const categorizer = require('../ai/categorizer');
const nameCleaner = require('../ai/nameCleaner');
const scheduler = require('../ai/scheduler');
const fileUtils = require('../utils/fileUtils');
const networkUtils = require('../utils/networkUtils');
const logger = require('../utils/logger');

const DEFAULT_SAVE_DIR = path.join(os.homedir(), 'Downloads', 'Nexus');
const TEMP_BASE = path.join(
  process.env.NEXUS_DATA_DIR || path.join(os.homedir(), '.nexus'),
  'temp'
);

const DEFAULT_MAX_CONCURRENT = 4;
const PROGRESS_SAVE_INTERVAL = 5_000; // ms

// ─── Types ────────────────────────────────────────────────────────────────────

/** Recognised download types (also used for engine routing). */
const TYPE = {
  HLS:    'hls',
  DASH:   'dash',
  YT:     'yt',
  FILE:   'file',
};

/** All valid statuses */
const STATUS = {
  QUEUED:      'queued',
  CONNECTING:  'connecting',
  DOWNLOADING: 'downloading',
  PAUSED:      'paused',
  MERGING:     'merging',
  COMPLETE:    'completed',
  ERROR:       'error',
  CANCELLED:   'cancelled',
};

/**
 * DownloadManager – central orchestrator for all downloads.
 *
 * Emits: 'update' (id, changes)
 *        'new'    (downloadRecord)
 *        'complete' (downloadRecord)
 *        'error'  (id, error)
 */
class DownloadManager extends EventEmitter {
  constructor() {
    super();

    // id → AbortController
    this.active = new Map();

    // FIFO queue of pending download IDs (priority-sorted on insertion)
    this.queue = [];

    // id → { timer, engine }
    this._progressSavers = new Map();

    // id → partial progress state for DB updates
    this._progressCache = new Map();

    // Progress flush timer
    this._flushTimer = setInterval(() => this._flushProgress(), 500);

    // Read concurrency from settings (with a safe fallback)
    this._maxConcurrent = DEFAULT_MAX_CONCURRENT;
    this._loadSettings();

    if (!fs.existsSync(TEMP_BASE)) fs.mkdirSync(TEMP_BASE, { recursive: true });
    if (!fs.existsSync(DEFAULT_SAVE_DIR)) fs.mkdirSync(DEFAULT_SAVE_DIR, { recursive: true });
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Re-queue downloads that were in-progress when the app last exited.
   * Also surfaces any `.nexus_state` files left over from crashes.
   */
  async restoreSession() {
    const q = getStatements();

    // 1. Re-queue DB-tracked downloads that were active
    const active = q.getActiveDownloads.all();
    for (const dl of active) {
      logger.info('Restoring download', { id: dl.id, url: dl.url });
      q.updateDownloadStatus.run({ id: dl.id, status: STATUS.QUEUED });
      this._enqueue(dl.id, dl.priority || 5);
    }

    // 2. Discover orphaned .nexus_state files (from crashes)
    const orphaned = resumeManager.discoverAll();
    for (const state of orphaned) {
      if (!state.url) continue;
      const existing = q.getDownloadsByStatus.all(STATUS.COMPLETE).find(
        (d) => d.url === state.url
      );
      if (existing) continue; // already done
      logger.info('Found orphaned resume state', { url: state.url });
      // The download will be re-created on user confirmation via addDownload()
    }

    this._processQueue();
  }

  destroy() {
    clearInterval(this._flushTimer);
    for (const [id] of this._progressSavers) {
      this._stopProgressSaver(id);
    }
  }

  // ─── Queue management ─────────────────────────────────────────────────────

  /**
   * Add a new download.
   * @param {object} data
   * @returns {Promise<string>} download ID
   */
  async add(data) {
    const {
      url,
      saveDir       = DEFAULT_SAVE_DIR,
      filename      = '',
      category      = null,
      referrer      = '',
      headers       = {},
      priority      = 5,
      type          = null,   // 'hls' | 'dash' | 'yt' | 'file'
      isYtdlp       = false,
      quality       = null,
      format        = null,
      subtitles     = false,
      subtitleLangs = ['en'],
      playlistId    = null,
      playlistIndex = null,
      pageUrl       = null,
      pageTitle     = null,
      thumbnailUrl  = null,
    } = data;

    const id = uuidv4();
    const q = getStatements();

    // Probe URL if no filename given
    let resolvedFilename = filename;
    let fileSize = 0;
    let mimeType = '';

    if (!resolvedFilename) {
      try {
        const probe = await networkUtils.probeUrl(url, headers);
        resolvedFilename = probe.filename || path.basename(new URL(url).pathname) || 'download';
        fileSize = probe.size || 0;
        mimeType = probe.contentType || '';
      } catch (_) {
        try {
          resolvedFilename = path.basename(new URL(url).pathname) || 'download';
        } catch (__) {
          resolvedFilename = 'download';
        }
      }
    }

    resolvedFilename = nameCleaner.clean(resolvedFilename);
    const resolvedCategory = category || categorizer.categorize(resolvedFilename, mimeType, url);
    const finalSaveDir = fileUtils.ensureDir(path.join(saveDir, resolvedCategory));

    // Determine engine type
    const resolvedType = type || (isYtdlp || networkUtils.isYtdlpSupported(url) ? TYPE.YT : TYPE.FILE);

    q.insertDownload.run({
      id,
      url,
      title: resolvedFilename,
      filename: resolvedFilename,
      save_path: finalSaveDir,
      category: resolvedCategory,
      status: STATUS.QUEUED,
      file_size: fileSize,
      downloaded: 0,
      mime_type: mimeType,
      referrer,
      headers: JSON.stringify(headers),
      is_hls: resolvedType === TYPE.HLS ? 1 : 0,
      is_dash: resolvedType === TYPE.DASH ? 1 : 0,
      is_playlist: playlistId ? 1 : 0,
      playlist_id: playlistId || null,
      priority,
      max_retries: 5,
    });

    logger.info('Download added', { id, url, resolvedFilename, resolvedCategory });

    const record = q.getDownload.get(id);
    this.emit('new', record);

    // Record this download's hour for AI scheduler
    try { scheduler.recordDownload(); } catch (_) {}

    if (scheduler.canStart()) {
      this._enqueue(id, priority);
      this._processQueue();
    }

    return id;
  }

  _processQueue() {
    while (this.active.size < this._maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift();
      if (!id) continue;
      const q = getStatements();
      const dl = q.getDownload.get(id);
      if (!dl || dl.status === STATUS.CANCELLED || dl.status === STATUS.COMPLETE) continue;
      this._startDownload(dl).catch((err) => {
        logger.error('Unhandled error starting download', { id, err: err.message });
      });
    }
  }

  _enqueue(id, priority = 5) {
    if (this.queue.includes(id)) return;
    // Priority queue (higher priority = closer to front)
    const insertIdx = this.queue.findIndex((qId) => {
      const q = getStatements();
      const dl = q.getDownload.get(qId);
      return !dl || (dl.priority || 5) < priority;
    });
    if (insertIdx === -1) {
      this.queue.push(id);
    } else {
      this.queue.splice(insertIdx, 0, id);
    }
  }

  _onFinish(id) {
    this.active.delete(id);
    this._stopProgressSaver(id);
    this._processQueue();
  }

  // ─── Public controls ──────────────────────────────────────────────────────

  /** @deprecated Use add() */
  async addDownload(opts) { return this.add(opts); }

  async startDownload(id) {
    const q = getStatements();
    const dl = q.getDownload.get(id);
    if (!dl) throw new Error(`Download ${id} not found`);
    if (this.active.has(id)) return;

    q.updateDownloadStatus.run({ id, status: STATUS.QUEUED });
    this._enqueue(id, dl.priority || 5);
    this._processQueue();
  }

  pause(id) {
    const ctrl = this.active.get(id);
    if (ctrl) ctrl.abort();

    const q = getStatements();
    q.updateDownloadStatus.run({ id, status: STATUS.PAUSED });
    this._stopProgressSaver(id);
    this.active.delete(id);
    this.emit('update', id, { status: STATUS.PAUSED });
    logger.info('Download paused', { id });
  }

  /** @deprecated Use pause() */
  pauseDownload(id) { return this.pause(id); }

  resume(id) {
    const q = getStatements();
    const dl = q.getDownload.get(id);
    if (!dl) return;
    if (dl.status === STATUS.PAUSED) {
      this._enqueue(id, dl.priority || 5);
      this._processQueue();
    }
  }

  /** @deprecated Use resume() */
  resumeDownload(id) { return this.resume(id); }

  cancel(id) {
    const ctrl = this.active.get(id);
    if (ctrl) ctrl.abort();
    this.active.delete(id);
    this._stopProgressSaver(id);
    this.queue = this.queue.filter((qId) => qId !== id);

    // Clean temp files
    const tempDir = path.join(TEMP_BASE, id);
    if (fs.existsSync(tempDir)) {
      try {
        for (const f of fs.readdirSync(tempDir)) {
          try { fs.unlinkSync(path.join(tempDir, f)); } catch (_) {}
        }
        fs.rmdirSync(tempDir);
      } catch (_) {}
    }

    const q = getStatements();
    const dl = q.getDownload.get(id);
    if (dl) resumeManager.clearById(id);

    q.updateDownloadStatus.run({ id, status: STATUS.CANCELLED });
    this.emit('update', id, { status: STATUS.CANCELLED });
    logger.info('Download cancelled', { id });
  }

  /** @deprecated Use cancel() */
  cancelDownload(id) { return this.cancel(id); }

  retry(id) {
    const q = getStatements();
    const dl = q.getDownload.get(id);
    if (!dl) return;
    q.updateDownloadStatus.run({ id, status: STATUS.QUEUED });
    q.incrementRetries.run(id);
    this._enqueue(id, dl.priority || 5);
    this._processQueue();
  }

  pauseAll() {
    for (const [id] of this.active) this.pause(id);
  }

  resumeAll() {
    const q = getStatements();
    const paused = q.getDownloadsByStatus.all(STATUS.PAUSED);
    for (const dl of paused) this.resume(dl.id);
  }

  deleteDownload(id, deleteFile = false) {
    this.cancel(id);
    const q = getStatements();
    if (deleteFile) {
      const dl = q.getDownload.get(id);
      if (dl) {
        const fp = path.join(dl.save_path, dl.filename);
        if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch (_) {} }
      }
    }
    q.deleteDownload.run(id);
    this.emit('update', id, { deleted: true });
  }

  /**
   * Add all entries of a playlist as individual downloads.
   * @param {object} data   { url, entries: [{title, url}], quality, saveDir, ... }
   * @returns {Promise<string[]>} array of download IDs
   */
  async addPlaylist(data) {
    const { entries = [], ...commonOpts } = data;
    const ids = [];

    // Insert playlist record
    const playlistId = uuidv4();
    const q = getStatements();
    q.insertPlaylist.run({
      id: playlistId,
      url: data.url || '',
      title: data.title || 'Playlist',
      total: entries.length,
    });

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const id = await this.add({
        ...commonOpts,
        url: entry.url,
        filename: entry.title || '',
        playlistId,
        playlistIndex: i,
        thumbnailUrl: entry.thumbnail || null,
      });
      ids.push(id);
    }

    this._processQueue();
    return ids;
  }

  getAll() {
    return getStatements().getAllDownloads.all();
  }

  getOne(id) {
    return getStatements().getDownload.get(id);
  }

  // ─── Private: engine routing ──────────────────────────────────────────────

  async _startDownload(dl) {
    const ctrl = new AbortController();
    this.active.set(dl.id, ctrl);

    const q = getStatements();
    q.updateDownloadStarted.run({ id: dl.id });
    this.emit('update', dl.id, { status: STATUS.DOWNLOADING });

    const tempDir = path.join(TEMP_BASE, dl.id);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    try {
      const type = this._resolveType(dl);

      if (type === TYPE.HLS) {
        await this._runHls(dl, tempDir, ctrl);
      } else if (type === TYPE.DASH) {
        await this._runDash(dl, tempDir, ctrl);
      } else if (type === TYPE.YT) {
        await this._runYtdlp(dl, ctrl);
      } else {
        await this._runChunk(dl, tempDir, ctrl);
      }

      q.updateDownloadCompleted.run({ id: dl.id });
      q.upsertStats.run({ downloaded: dl.file_size || 0 });
      resumeManager.clearById(dl.id);
      this._onFinish(dl.id);

      const completed = q.getDownload.get(dl.id);
      this.emit('update', dl.id, { status: STATUS.COMPLETE, progress: 100 });
      this.emit('complete', completed);
      logger.info('Download complete', { id: dl.id });
    } catch (err) {
      if (ctrl.signal.aborted) {
        // Aborted intentionally – status already updated by pause/cancel
        this._onFinish(dl.id);
        return;
      }

      const current = q.getDownload.get(dl.id);
      const retries = current?.retries || 0;
      const maxRetries = dl.max_retries || 5;

      if (retries < maxRetries) {
        q.incrementRetries.run(dl.id);
        const delay = 1000 * Math.pow(2, retries);
        logger.warn('Download error – scheduling retry', {
          id: dl.id, retries: retries + 1, delay, err: err.message,
        });
        this._onFinish(dl.id);
        setTimeout(() => {
          const q2 = getStatements();
          q2.updateDownloadStatus.run({ id: dl.id, status: STATUS.QUEUED });
          this._enqueue(dl.id, dl.priority || 5);
          this._processQueue();
        }, delay);
      } else {
        q.updateDownloadError.run({ id: dl.id, error_msg: err.message });
        this._onFinish(dl.id);
        this.emit('update', dl.id, { status: STATUS.ERROR, error_msg: err.message });
        this.emit('error', dl.id, err);
        logger.error('Download failed permanently', { id: dl.id, err: err.message });
      }
    }
  }

  _resolveType(dl) {
    if (dl.is_hls) return TYPE.HLS;
    if (dl.is_dash) return TYPE.DASH;
    if (networkUtils.isYtdlpSupported(dl.url)) return TYPE.YT;
    return TYPE.FILE;
  }

  async _runChunk(dl, tempDir, ctrl) {
    const headers = dl.headers ? JSON.parse(dl.headers) : {};
    const outputFile = path.join(dl.save_path, dl.filename);
    const q = getStatements();

    const onProgress = (p) => {
      this._progressCache.set(dl.id, {
        downloaded: p.downloaded,
        speed: p.speed || 0,
        progress: p.progress || 0,
        eta: p.eta || 0,
      });
      this.emit('update', dl.id, {
        status: STATUS.DOWNLOADING,
        downloaded: p.downloaded,
        total: p.total,
        progress: p.progress,
        speed: p.speed,
        eta: p.eta,
        chunksActive: p.chunksActive,
        chunksComplete: p.chunksComplete,
      });
    };

    await downloadWithChunks(
      dl.url,
      outputFile,
      { headers, downloadId: dl.id, controller: ctrl },
      onProgress
    );
  }

  async _runYtdlp(dl, ctrl) {
    const engine = new YtdlpEngine({
      url: dl.url,
      outputDir: dl.save_path,
      quality: dl.quality || null,
    });

    const q = getStatements();

    await new Promise((resolve, reject) => {
      engine.on('progress', (p) => {
        const progress = Math.min(100, p.percent || 0);
        this._progressCache.set(dl.id, { downloaded: 0, speed: 0, progress, eta: 0 });
        this.emit('update', dl.id, { status: STATUS.DOWNLOADING, progress });
      });
      engine.on('complete', resolve);
      engine.on('error', reject);

      ctrl.signal.addEventListener('abort', () => engine.abort());
      engine.download().catch(reject);
    });
  }

  async _runHls(dl, tempDir, ctrl) {
    const headers = dl.headers ? JSON.parse(dl.headers) : {};
    const outputFile = path.join(dl.save_path, dl.filename);

    const engine = new HlsEngine({ url: dl.url, outputFile, tempDir, headers });

    await new Promise((resolve, reject) => {
      engine.on('progress', (p) => {
        this.emit('update', dl.id, { status: STATUS.DOWNLOADING, ...p });
      });
      engine.on('complete', resolve);
      engine.on('error', reject);

      ctrl.signal.addEventListener('abort', () => engine.abort());
      engine.start().catch(reject);
    });
  }

  async _runDash(dl, tempDir, ctrl) {
    const headers = dl.headers ? JSON.parse(dl.headers) : {};
    const outputFile = path.join(dl.save_path, dl.filename);

    const engine = new DashEngine({ url: dl.url, outputFile, tempDir, headers });

    await new Promise((resolve, reject) => {
      engine.on('progress', (p) => {
        this.emit('update', dl.id, { status: STATUS.DOWNLOADING, ...p });
      });
      engine.on('complete', resolve);
      engine.on('error', reject);

      ctrl.signal.addEventListener('abort', () => engine.abort());
      engine.start().catch(reject);
    });
  }

  // ─── Progress persistence ────────────────────────────────────────────────

  _flushProgress() {
    if (this._progressCache.size === 0) return;
    const q = getStatements();
    for (const [id, p] of this._progressCache) {
      try {
        q.updateDownloadProgress.run({ id, ...p });
      } catch (_) {}
    }
    this._progressCache.clear();
  }

  _startProgressSaver(id, getStateFn) {
    this._stopProgressSaver(id);
    const timer = setInterval(() => {
      try {
        const state = getStateFn();
        if (state) resumeManager.save(id, state);
      } catch (_) {}
    }, PROGRESS_SAVE_INTERVAL);
    this._progressSavers.set(id, timer);
  }

  _stopProgressSaver(id) {
    const timer = this._progressSavers.get(id);
    if (timer) {
      clearInterval(timer);
      this._progressSavers.delete(id);
    }
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  _loadSettings() {
    try {
      const q = getStatements();
      const row = q.getSetting.get('max_concurrent');
      if (row) this._maxConcurrent = parseInt(row.value, 10) || DEFAULT_MAX_CONCURRENT;
    } catch (_) {}
  }

  updateMaxConcurrent(n) {
    this._maxConcurrent = Math.max(1, Math.min(16, n));
    this._processQueue();
  }
}

module.exports = new DownloadManager();
