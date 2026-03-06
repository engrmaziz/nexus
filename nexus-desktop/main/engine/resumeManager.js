'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../utils/logger');

const DEFAULT_TEMP_DIR = path.join(
  process.env.NEXUS_DATA_DIR || path.join(os.homedir(), '.nexus'),
  'temp'
);

/**
 * ResumeManager – persists and restores download state via `.nexus_state` files.
 *
 * Each active download writes a `.nexus_state` file every 5 seconds next to
 * its output file, containing the full chunk map needed to resume.
 *
 * On next launch, `discoverAll()` scans the temp directory for any leftover
 * `.nexus_state` files so the user can be offered to resume them.
 *
 * State file format:
 * {
 *   url, finalUrl, fileSize, chunkCount,
 *   chunks: [{ index, start, end, downloaded, complete, tempFile }],
 *   headers: { cookie, etag, lastModified },
 *   savedAt: timestamp (ms)
 * }
 */
class ResumeManager {
  /**
   * @param {string} [tempDir]  Base temp directory where `.nexus_state` files live.
   */
  constructor(tempDir = DEFAULT_TEMP_DIR) {
    this._tempDir = tempDir;
    if (!fs.existsSync(this._tempDir)) {
      fs.mkdirSync(this._tempDir, { recursive: true });
    }
    /** map: outputPath → interval timer */
    this._timers = new Map();
    /** map: outputPath → latest state object */
    this._states = new Map();
  }

  // ─── State file path helpers ──────────────────────────────────────────────

  /**
   * The `.nexus_state` file lives next to the output file.
   * @param {string} outputPath
   */
  stateFilePath(outputPath) {
    return outputPath + '.nexus_state';
  }

  // ─── Save / Load / Clear ──────────────────────────────────────────────────

  /**
   * Persist state to the `.nexus_state` file immediately.
   * @param {string} outputPath  Final output file path.
   * @param {object} state       State object matching the format above.
   */
  save(outputPath, state) {
    const filePath = this.stateFilePath(outputPath);
    const payload = { ...state, savedAt: Date.now() };
    try {
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
      this._states.set(outputPath, payload);
      logger.debug('Resume state saved', { filePath });
    } catch (err) {
      logger.error('Failed to save resume state', { filePath, err: err.message });
    }
  }

  /**
   * Load state from the `.nexus_state` file. Returns null if absent or corrupt.
   * @param {string} outputPath
   * @returns {object|null}
   */
  load(outputPath) {
    // Check in-memory cache first
    if (this._states.has(outputPath)) return this._states.get(outputPath);

    const filePath = this.stateFilePath(outputPath);
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const state = JSON.parse(raw);
      this._states.set(outputPath, state);
      logger.debug('Resume state loaded', {
        filePath,
        savedAt: new Date(state.savedAt).toISOString(),
      });
      return state;
    } catch (err) {
      logger.warn('Failed to parse resume state – ignoring', { filePath, err: err.message });
      return null;
    }
  }

  /**
   * Check whether a `.nexus_state` file exists for the given output path.
   * @param {string} outputPath
   * @returns {boolean}
   */
  exists(outputPath) {
    return fs.existsSync(this.stateFilePath(outputPath));
  }

  /**
   * Delete the `.nexus_state` file (called after a successful merge).
   * Also stops the auto-save timer if one was running.
   * @param {string} outputPath
   */
  clear(outputPath) {
    this.stopAutoSave(outputPath);
    this._states.delete(outputPath);
    const filePath = this.stateFilePath(outputPath);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        logger.debug('Resume state cleared', { filePath });
      } catch (err) {
        logger.warn('Could not delete resume state', { filePath, err: err.message });
      }
    }
  }

  /**
   * Delete the `.nexus_state` file AND all associated temp chunk files.
   * @param {string} outputPath
   * @param {string[]} tempFiles  Absolute paths to `.part_N` temp files.
   */
  clearWithTempFiles(outputPath, tempFiles = []) {
    this.clear(outputPath);
    for (const f of tempFiles) {
      if (f && fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch (_) {}
      }
    }
  }

  // ─── Auto-save timer ─────────────────────────────────────────────────────

  /**
   * Start saving state every 5 seconds.
   * `getStateFn` is called each interval and should return the current state object.
   * @param {string}   outputPath
   * @param {Function} getStateFn  () => state object
   */
  startAutoSave(outputPath, getStateFn) {
    this.stopAutoSave(outputPath);
    const timer = setInterval(() => {
      try {
        const state = getStateFn();
        if (state) this.save(outputPath, state);
      } catch (err) {
        logger.warn('Auto-save error', { outputPath, err: err.message });
      }
    }, 5000);
    this._timers.set(outputPath, timer);
  }

  /**
   * Stop the auto-save timer for the given output path.
   * @param {string} outputPath
   */
  stopAutoSave(outputPath) {
    const timer = this._timers.get(outputPath);
    if (timer) {
      clearInterval(timer);
      this._timers.delete(outputPath);
    }
  }

  /** Stop ALL active auto-save timers (call on app shutdown). */
  stopAll() {
    for (const [outputPath] of this._timers) {
      this.stopAutoSave(outputPath);
    }
  }

  // ─── Discovery ────────────────────────────────────────────────────────────

  /**
   * Scan `tempDir` recursively (one level deep) for leftover `.nexus_state` files.
   * Returns an array of parsed state objects with an added `_stateFile` property.
   * @returns {object[]}
   */
  discoverAll() {
    const found = [];
    const scanDir = (dir) => {
      if (!fs.existsSync(dir)) return;
      let entries;
      try { entries = fs.readdirSync(dir); } catch (_) { return; }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        if (entry.endsWith('.nexus_state')) {
          try {
            const raw = fs.readFileSync(fullPath, 'utf8');
            const state = JSON.parse(raw);
            state._stateFile = fullPath;
            found.push(state);
          } catch (_) {}
        } else {
          // One level deeper
          try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              const subEntries = fs.readdirSync(fullPath);
              for (const sub of subEntries) {
                if (sub.endsWith('.nexus_state')) {
                  const subPath = path.join(fullPath, sub);
                  try {
                    const raw = fs.readFileSync(subPath, 'utf8');
                    const state = JSON.parse(raw);
                    state._stateFile = subPath;
                    found.push(state);
                  } catch (_) {}
                }
              }
            }
          } catch (_) {}
        }
      }
    };

    // Also scan temp directory
    scanDir(this._tempDir);

    return found;
  }

  // ─── Legacy compatibility (used by downloadManager) ──────────────────────

  /**
   * @deprecated Use save(outputPath, state) instead.
   */
  saveById(downloadId, state) {
    const filePath = this._legacyStateFile(downloadId);
    const payload = { ...state, savedAt: Date.now() };
    try {
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
      logger.error('Failed to save resume state (legacy)', { downloadId, err: err.message });
    }
  }

  /** @deprecated */
  loadById(downloadId) {
    const filePath = this._legacyStateFile(downloadId);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
      return null;
    }
  }

  /** @deprecated */
  clearById(downloadId) {
    const filePath = this._legacyStateFile(downloadId);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (_) {}
    }
  }

  /** @deprecated – kept for downloadManager compatibility */
  updateChunks(downloadId, chunks) {
    const state = this.loadById(downloadId);
    if (!state) return;
    state.chunks = chunks;
    state.downloaded = chunks.reduce((a, c) => a + (c.downloaded || 0), 0);
    this.saveById(downloadId, state);
  }

  /** @deprecated */
  listAll() {
    const legacyDir = path.join(
      process.env.NEXUS_DATA_DIR || path.join(os.homedir(), '.nexus'),
      'resume'
    );
    if (!fs.existsSync(legacyDir)) return [];
    try {
      return fs.readdirSync(legacyDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => path.basename(f, '.json'));
    } catch (_) {
      return [];
    }
  }

  _legacyStateFile(downloadId) {
    const legacyDir = path.join(
      process.env.NEXUS_DATA_DIR || path.join(os.homedir(), '.nexus'),
      'resume'
    );
    if (!fs.existsSync(legacyDir)) {
      fs.mkdirSync(legacyDir, { recursive: true });
    }
    const safe = downloadId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(legacyDir, `${safe}.json`);
  }
}

module.exports = new ResumeManager();
