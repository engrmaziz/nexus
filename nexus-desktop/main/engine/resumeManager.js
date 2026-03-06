'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../utils/logger');

const STATE_DIR = path.join(
  process.env.NEXUS_DATA_DIR || path.join(os.homedir(), '.nexus'),
  'resume'
);

/**
 * ResumeManager – persists and restores the download state of each download
 * so that interrupted sessions can be resumed.
 *
 * State files are stored as JSON under ~/.nexus/resume/<downloadId>.json
 */
class ResumeManager {
  constructor() {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }
  }

  /**
   * Persist state for a given download.
   * @param {string} downloadId
   * @param {object} state  { url, outputFile, tempDir, fileSize, downloaded, chunks[] }
   */
  save(downloadId, state) {
    const filePath = this._stateFile(downloadId);
    try {
      fs.writeFileSync(filePath, JSON.stringify({ ...state, savedAt: Date.now() }, null, 2), 'utf8');
      logger.debug('Resume state saved', { downloadId });
    } catch (err) {
      logger.error('Failed to save resume state', { downloadId, err: err.message });
    }
  }

  /**
   * Load the persisted state for a download. Returns null if none exists.
   * @param {string} downloadId
   * @returns {object|null}
   */
  load(downloadId) {
    const filePath = this._stateFile(downloadId);
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const state = JSON.parse(raw);
      logger.debug('Resume state loaded', { downloadId, savedAt: new Date(state.savedAt).toISOString() });
      return state;
    } catch (err) {
      logger.warn('Failed to load resume state', { downloadId, err: err.message });
      return null;
    }
  }

  /**
   * Check whether a valid resume state exists.
   * @param {string} downloadId
   * @returns {boolean}
   */
  exists(downloadId) {
    return fs.existsSync(this._stateFile(downloadId));
  }

  /**
   * Delete the resume state for a download (called on completion or cancellation).
   * @param {string} downloadId
   */
  clear(downloadId) {
    const filePath = this._stateFile(downloadId);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        logger.debug('Resume state cleared', { downloadId });
      } catch (err) {
        logger.warn('Could not delete resume state', { downloadId, err: err.message });
      }
    }
  }

  /**
   * Delete resume state AND all associated temp chunk files.
   * @param {string} downloadId
   * @param {string[]} tempFiles  list of absolute paths to temp files
   */
  clearWithTempFiles(downloadId, tempFiles = []) {
    this.clear(downloadId);
    for (const f of tempFiles) {
      if (f && fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch (_) {}
      }
    }
  }

  /**
   * Update the 'downloaded' byte count for each chunk in a saved state.
   * @param {string} downloadId
   * @param {object[]} chunks
   */
  updateChunks(downloadId, chunks) {
    const state = this.load(downloadId);
    if (!state) return;
    state.chunks = chunks;
    state.downloaded = chunks.reduce((a, c) => a + (c.downloaded || 0), 0);
    this.save(downloadId, state);
  }

  /**
   * List all download IDs that have a persisted resume state.
   * @returns {string[]}
   */
  listAll() {
    try {
      return fs
        .readdirSync(STATE_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => path.basename(f, '.json'));
    } catch (_) {
      return [];
    }
  }

  _stateFile(downloadId) {
    // Sanitize to avoid path traversal
    const safe = downloadId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(STATE_DIR, `${safe}.json`);
  }
}

module.exports = new ResumeManager();
