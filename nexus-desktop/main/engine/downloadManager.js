'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const PQueue = require('p-queue').default;

const { getStatements } = require('../db/queries');
const ChunkEngine = require('./chunkEngine');
const YtdlpEngine = require('./ytdlpEngine');
const HlsEngine = require('./hlsEngine');
const DashEngine = require('./dashEngine');
const MergeEngine = require('./mergeEngine');
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
const MAX_CONCURRENT = 3;
const PROGRESS_INTERVAL_MS = 500;

/**
 * DownloadManager – central orchestrator for all downloads.
 *
 * Emits: 'update' (downloadId, changes)
 */
class DownloadManager extends EventEmitter {
  constructor() {
    super();
    this.queue = new PQueue({ concurrency: MAX_CONCURRENT });
    this.activeEngines = new Map(); // downloadId -> engine
    this._progressTimers = new Map();

    if (!fs.existsSync(TEMP_BASE)) fs.mkdirSync(TEMP_BASE, { recursive: true });
    if (!fs.existsSync(DEFAULT_SAVE_DIR)) fs.mkdirSync(DEFAULT_SAVE_DIR, { recursive: true });
  }

  // ──────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Resume any downloads that were active when the app last closed.
   */
  async restoreSession() {
    const q = getStatements();
    const active = q.getActiveDownloads.all();
    for (const dl of active) {
      // Put back as queued so they restart
      q.updateDownloadStatus.run({ id: dl.id, status: 'queued' });
      logger.info('Restoring download', { id: dl.id, url: dl.url });
      await this.startDownload(dl.id);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Add a new download to the queue.
   * @param {object} opts
   * @returns {string} download id
   */
  async addDownload(opts) {
    const {
      url,
      saveDir = DEFAULT_SAVE_DIR,
      filename: overrideFilename,
      category: overrideCategory,
      referrer,
      headers = {},
      priority = 5,
      isHls = false,
      isDash = false,
      isPlaylist = false,
      playlistId = null,
      format,
      quality,
      subtitles = false,
      subtitleLangs = ['en'],
    } = opts;

    const id = uuidv4();
    const q = getStatements();

    // Probe URL to get filename / size
    let filename = overrideFilename || '';
    let fileSize = 0;
    let mimeType = '';

    if (!filename) {
      try {
        const probe = await networkUtils.probeUrl(url, headers);
        filename = probe.filename || path.basename(new URL(url).pathname) || 'download';
        fileSize = probe.size || 0;
        mimeType = probe.contentType || '';
      } catch (_) {
        filename = path.basename(new URL(url).pathname) || 'download';
      }
    }

    filename = nameCleaner.clean(filename);
    const category = overrideCategory || categorizer.categorize(filename, mimeType, url);

    const finalSaveDir = fileUtils.ensureDir(path.join(saveDir, category));

    q.insertDownload.run({
      id,
      url,
      title: filename,
      filename,
      save_path: finalSaveDir,
      category,
      status: 'queued',
      file_size: fileSize,
      downloaded: 0,
      mime_type: mimeType,
      referrer: referrer || '',
      headers: JSON.stringify(headers),
      is_hls: isHls ? 1 : 0,
      is_dash: isDash ? 1 : 0,
      is_playlist: isPlaylist ? 1 : 0,
      playlist_id: playlistId,
      priority,
      max_retries: 3,
    });

    logger.info('Download added', { id, url, filename, category });

    // Check if scheduler allows immediate start
    if (scheduler.canStart()) {
      await this.startDownload(id);
    }

    return id;
  }

  /**
   * Start (or re-start) a download by id.
   */
  async startDownload(id) {
    const q = getStatements();
    const dl = q.getDownload.get(id);
    if (!dl) throw new Error(`Download ${id} not found`);

    if (this.activeEngines.has(id)) {
      logger.warn('Download already active', { id });
      return;
    }

    q.updateDownloadStatus.run({ id, status: 'queued' });

    this.queue.add(() => this._run(dl)).catch((err) => {
      logger.error('Unhandled error in download queue', { id, err: err.message });
    });
  }

  /**
   * Pause an active download.
   */
  pauseDownload(id) {
    const engine = this.activeEngines.get(id);
    if (engine && typeof engine.pause === 'function') {
      engine.pause();
    }
    const q = getStatements();
    q.updateDownloadStatus.run({ id, status: 'paused' });
    this._stopProgressTimer(id);
    this.emit('update', id, { status: 'paused' });
  }

  /**
   * Resume a paused download.
   */
  resumeDownload(id) {
    const engine = this.activeEngines.get(id);
    if (engine && typeof engine.resume === 'function') {
      engine.resume();
      const q = getStatements();
      q.updateDownloadStatus.run({ id, status: 'downloading' });
      this.emit('update', id, { status: 'downloading' });
    } else {
      // Re-queue from resume state
      this.startDownload(id);
    }
  }

  /**
   * Cancel and remove a download.
   */
  cancelDownload(id) {
    const engine = this.activeEngines.get(id);
    if (engine && typeof engine.abort === 'function') {
      engine.abort();
    }
    this.activeEngines.delete(id);
    this._stopProgressTimer(id);
    resumeManager.clear(id);

    const q = getStatements();
    q.updateDownloadStatus.run({ id, status: 'cancelled' });
    this.emit('update', id, { status: 'cancelled' });
    logger.info('Download cancelled', { id });
  }

  /**
   * Delete a download record (and optionally its file).
   */
  deleteDownload(id, deleteFile = false) {
    this.cancelDownload(id);
    const q = getStatements();
    if (deleteFile) {
      const dl = q.getDownload.get(id);
      if (dl && dl.save_path && dl.filename) {
        const fp = path.join(dl.save_path, dl.filename);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      }
    }
    q.deleteDownload.run(id);
    this.emit('update', id, { deleted: true });
  }

  /**
   * Return all downloads from the database.
   */
  getAll() {
    return getStatements().getAllDownloads.all();
  }

  /**
   * Return a single download record.
   */
  getOne(id) {
    return getStatements().getDownload.get(id);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────

  async _run(dl) {
    const q = getStatements();
    q.updateDownloadStarted.run({ id: dl.id });
    this.emit('update', dl.id, { status: 'downloading' });

    const tempDir = path.join(TEMP_BASE, dl.id);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    try {
      if (dl.is_hls) {
        await this._runHls(dl, tempDir);
      } else if (dl.is_dash) {
        await this._runDash(dl, tempDir);
      } else if (networkUtils.isYtdlpSupported(dl.url)) {
        await this._runYtdlp(dl, tempDir);
      } else {
        await this._runChunk(dl, tempDir);
      }

      q.updateDownloadCompleted.run({ id: dl.id });
      q.upsertStats.run({ downloaded: dl.file_size || 0 });
      resumeManager.clear(dl.id);
      this._stopProgressTimer(dl.id);
      this.activeEngines.delete(dl.id);
      this.emit('update', dl.id, { status: 'completed', progress: 100 });
      logger.info('Download completed', { id: dl.id, url: dl.url });
    } catch (err) {
      if (this.activeEngines.get(dl.id) === undefined) return; // was cancelled

      const retries = q.getDownload.get(dl.id)?.retries || 0;
      const maxRetries = dl.max_retries || 3;

      if (retries < maxRetries) {
        q.incrementRetries.run(dl.id);
        logger.warn('Download error – retrying', { id: dl.id, retries: retries + 1, err: err.message });
        setTimeout(() => this.startDownload(dl.id), 5000 * (retries + 1));
      } else {
        q.updateDownloadError.run({ id: dl.id, error_msg: err.message });
        this.activeEngines.delete(dl.id);
        this._stopProgressTimer(dl.id);
        this.emit('update', dl.id, { status: 'error', error_msg: err.message });
        logger.error('Download failed permanently', { id: dl.id, err: err.message });
      }
    }
  }

  async _runChunk(dl, tempDir) {
    const resumeState = resumeManager.load(dl.id);
    const outputFile = path.join(dl.save_path, dl.filename);
    const headers = dl.headers ? JSON.parse(dl.headers) : {};

    const engine = new ChunkEngine({
      url: dl.url,
      outputFile,
      tempDir,
      headers,
      numChunks: 32,
      resumeState: resumeState?.chunks || null,
    });

    this.activeEngines.set(dl.id, engine);
    this._startProgressTimer(dl.id, engine);

    return new Promise((resolve, reject) => {
      engine.on('complete', () => resolve());
      engine.on('error', reject);
      engine.start().catch(reject);
    });
  }

  async _runYtdlp(dl, tempDir) {
    const engine = new YtdlpEngine({
      url: dl.url,
      outputDir: dl.save_path,
    });

    this.activeEngines.set(dl.id, engine);

    const q = getStatements();

    return new Promise((resolve, reject) => {
      engine.on('progress', ({ percent }) => {
        const progress = Math.min(100, percent);
        q.updateDownloadProgress.run({
          id: dl.id,
          downloaded: 0,
          speed: 0,
          progress,
          eta: 0,
        });
        this.emit('update', dl.id, { progress });
      });
      engine.on('complete', () => resolve());
      engine.on('error', reject);
      engine.download().catch(reject);
    });
  }

  async _runHls(dl, tempDir) {
    const headers = dl.headers ? JSON.parse(dl.headers) : {};
    const outputFile = path.join(dl.save_path, dl.filename);

    const engine = new HlsEngine({
      url: dl.url,
      outputFile,
      tempDir,
      headers,
    });

    this.activeEngines.set(dl.id, engine);
    this._startProgressTimer(dl.id, engine);

    return new Promise((resolve, reject) => {
      engine.on('complete', () => resolve());
      engine.on('error', reject);
      engine.start().catch(reject);
    });
  }

  async _runDash(dl, tempDir) {
    const headers = dl.headers ? JSON.parse(dl.headers) : {};
    const outputFile = path.join(dl.save_path, dl.filename);

    const engine = new DashEngine({
      url: dl.url,
      outputFile,
      tempDir,
      headers,
    });

    this.activeEngines.set(dl.id, engine);
    this._startProgressTimer(dl.id, engine);

    return new Promise((resolve, reject) => {
      engine.on('complete', () => resolve());
      engine.on('error', reject);
      engine.start().catch(reject);
    });
  }

  _startProgressTimer(id, engine) {
    const q = getStatements();
    const timer = setInterval(() => {
      if (!engine) return;
      const state = typeof engine.getState === 'function' ? engine.getState() : null;
      if (state) {
        resumeManager.updateChunks(id, state);
      }
    }, 5000);
    this._progressTimers.set(id, timer);
  }

  _stopProgressTimer(id) {
    const timer = this._progressTimers.get(id);
    if (timer) {
      clearInterval(timer);
      this._progressTimers.delete(id);
    }
  }
}

module.exports = new DownloadManager();
