'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
// Inline Levenshtein distance – drop-in replacement for the ESM-only leven package.
// Uses a single rolling array (O(min(m,n)) space) by ensuring `a` is the shorter string.
function leven(a, b) {
  if (a === b) return 0;
  if (a.length > b.length) { const t = a; a = b; b = t; }
  if (a.length === 0) return b.length;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const temp = dp[i];
      dp[i] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[i], dp[i - 1]);
      prev = temp;
    }
  }
  return dp[a.length];
}
const logger = require('../utils/logger');

const HASH_BLOCK = 65536; // 64 KB block for quick hash

/**
 * DuplicateDetector – finds duplicate or near-duplicate download files.
 *
 * Detection strategies (in priority order):
 *  1. Same URL (exact match)
 *  2. File content hash of first + last 64 KB blocks (fast, fuzzy-proof)
 *  3. Filename Levenshtein distance (≤ threshold)
 */
class DuplicateDetector {
  constructor() {
    // url → { id, filename, savePath }
    this._urlIndex = new Map();
    // quickHash → { id, filename, savePath }
    this._hashIndex = new Map();
    // filename → [{ id, filename, savePath }]
    this._filenameIndex = new Map();
  }

  // ──────────────────────────────────────────────────────────────────────
  // Index management
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Seed the detector from the database downloads list.
   * @param {object[]} downloads  rows from the downloads table (status = 'completed')
   */
  seed(downloads) {
    for (const dl of downloads) {
      if (dl.status !== 'completed') continue;
      this._indexDownload(dl);
    }
    logger.debug('DuplicateDetector seeded', { count: downloads.length });
  }

  /**
   * Register a single download in the index.
   * @param {object} dl  download record
   */
  register(dl) {
    this._indexDownload(dl);
  }

  /**
   * Remove a download from the index.
   * @param {string} id  download id
   */
  remove(id) {
    for (const [key, val] of this._urlIndex) {
      if (val.id === id) { this._urlIndex.delete(key); break; }
    }
    for (const [key, val] of this._hashIndex) {
      if (val.id === id) { this._hashIndex.delete(key); break; }
    }
    for (const [key, list] of this._filenameIndex) {
      const filtered = list.filter((v) => v.id !== id);
      if (filtered.length === 0) this._filenameIndex.delete(key);
      else this._filenameIndex.set(key, filtered);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Detection
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Check whether a candidate download is a duplicate of an existing one.
   *
   * @param {object} candidate  { url, filename, savePath }
   * @param {object} [opts]
   * @param {number} [opts.levenThreshold=5]  max edit distance for filename similarity
   * @returns {{ isDuplicate: boolean, reason: string, match: object|null }}
   */
  check(candidate, opts = {}) {
    const { levenThreshold = 5 } = opts;

    // 1. URL match
    if (candidate.url && this._urlIndex.has(candidate.url)) {
      const match = this._urlIndex.get(candidate.url);
      return { isDuplicate: true, reason: 'url', match };
    }

    // 2. File hash match
    const filePath = candidate.savePath
      ? path.join(candidate.savePath, candidate.filename)
      : null;

    if (filePath && fs.existsSync(filePath)) {
      try {
        const quickHash = this._quickHash(filePath);
        if (this._hashIndex.has(quickHash)) {
          const match = this._hashIndex.get(quickHash);
          return { isDuplicate: true, reason: 'hash', match };
        }
      } catch (_) {}
    }

    // 3. Filename similarity
    if (candidate.filename) {
      const baseCandidate = path.basename(candidate.filename, path.extname(candidate.filename)).toLowerCase();
      for (const [key, list] of this._filenameIndex) {
        if (leven(baseCandidate, key) <= levenThreshold) {
          return { isDuplicate: true, reason: 'filename', match: list[0] };
        }
      }
    }

    return { isDuplicate: false, reason: null, match: null };
  }

  /**
   * Compute a quick fingerprint from the first+last HASH_BLOCK bytes of a file.
   * @param {string} filePath
   * @returns {string}
   */
  _quickHash(filePath) {
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const hash = crypto.createHash('sha256');

    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(HASH_BLOCK);

    // First block
    const firstRead = Math.min(HASH_BLOCK, fileSize);
    fs.readSync(fd, buf, 0, firstRead, 0);
    hash.update(buf.slice(0, firstRead));

    // Last block (if file is larger)
    if (fileSize > HASH_BLOCK) {
      const lastStart = Math.max(0, fileSize - HASH_BLOCK);
      const lastRead = Math.min(HASH_BLOCK, fileSize - lastStart);
      fs.readSync(fd, buf, 0, lastRead, lastStart);
      hash.update(buf.slice(0, lastRead));
    }

    fs.closeSync(fd);
    return hash.digest('hex');
  }

  _indexDownload(dl) {
    const entry = { id: dl.id, filename: dl.filename, savePath: dl.save_path };

    if (dl.url) this._urlIndex.set(dl.url, entry);

    const filePath = dl.save_path && dl.filename
      ? path.join(dl.save_path, dl.filename)
      : null;

    if (filePath && fs.existsSync(filePath)) {
      try {
        const h = this._quickHash(filePath);
        this._hashIndex.set(h, entry);
      } catch (_) {}
    }

    if (dl.filename) {
      const base = path.basename(dl.filename, path.extname(dl.filename)).toLowerCase();
      if (!this._filenameIndex.has(base)) this._filenameIndex.set(base, []);
      this._filenameIndex.get(base).push(entry);
    }
  }
}

module.exports = new DuplicateDetector();
