'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const SpeedTracker = require('./speedTracker');

const DEFAULT_CHUNKS = 32;
const MIN_CHUNK_SIZE = 512 * 1024;       // 512 KB
const MAX_CHUNK_SIZE = 32 * 1024 * 1024; // 32 MB
const STEAL_THRESHOLD = 0.15;            // steal when a chunk is <15% remaining
const CONNECT_TIMEOUT = 15_000;
const READ_TIMEOUT = 30_000;

/**
 * ChunkEngine – downloads a file in up to 32 parallel byte-range chunks.
 *
 * Emits:
 *   'progress'  { downloaded, total, speed, progress, eta }
 *   'complete'  { outputFile }
 *   'error'     Error
 */
class ChunkEngine extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string}  opts.url
   * @param {string}  opts.outputFile
   * @param {string}  opts.tempDir
   * @param {object}  [opts.headers]
   * @param {number}  [opts.numChunks]   defaults to 32
   * @param {object}  [opts.resumeState] previously saved chunk state
   */
  constructor(opts) {
    super();
    this.url = opts.url;
    this.outputFile = opts.outputFile;
    this.tempDir = opts.tempDir;
    this.headers = opts.headers || {};
    this.numChunks = opts.numChunks || DEFAULT_CHUNKS;
    this.resumeState = opts.resumeState || null;

    this.fileSize = 0;
    this.downloaded = 0;
    this.chunks = [];
    this.activeRequests = new Map(); // chunkIndex -> request
    this._aborted = false;
    this._paused = false;
    this.speedTracker = new SpeedTracker();
  }

  // ────────────────────────────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────────────────────────────

  async start() {
    try {
      this.fileSize = await this._getFileSize();

      if (this.fileSize === 0) {
        // Unknown content-length – single stream download
        await this._streamDownload();
        return;
      }

      this._initChunks();
      await this._downloadAllChunks();
      if (!this._aborted) await this._mergeChunks();
    } catch (err) {
      if (!this._aborted) this.emit('error', err);
    }
  }

  pause() {
    this._paused = true;
    for (const [, req] of this.activeRequests) {
      try { req.destroy(); } catch (_) {}
    }
    this.activeRequests.clear();
  }

  resume() {
    if (!this._paused) return;
    this._paused = false;
    this._downloadAllChunks().catch((err) => this.emit('error', err));
  }

  abort() {
    this._aborted = true;
    this.pause();
    this._cleanupTempFiles();
  }

  /**
   * Return current chunk state suitable for persisting to disk.
   */
  getState() {
    return this.chunks.map((c) => ({
      index: c.index,
      start: c.start,
      end: c.end,
      downloaded: c.downloaded,
      complete: c.complete,
      tempFile: c.tempFile,
    }));
  }

  // ────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ────────────────────────────────────────────────────────────────────────

  _getFileSize() {
    return new Promise((resolve, reject) => {
      const parsed = new URL(this.url);
      const mod = parsed.protocol === 'https:' ? https : http;

      const options = {
        method: 'HEAD',
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers: { ...this.headers },
        timeout: CONNECT_TIMEOUT,
      };

      const req = mod.request(options, (res) => {
        const cl = parseInt(res.headers['content-length'] || '0', 10);
        const acceptRanges = res.headers['accept-ranges'];
        // If server doesn't support ranges, use single-stream
        if (!acceptRanges || acceptRanges === 'none') {
          resolve(0);
        } else {
          resolve(cl);
        }
      });

      req.on('error', (err) => {
        logger.warn('HEAD request failed, falling back to stream', { err: err.message });
        resolve(0);
      });
      req.on('timeout', () => { req.destroy(); resolve(0); });
      req.end();
    });
  }

  _initChunks() {
    if (this.resumeState && this.resumeState.length > 0) {
      this.chunks = this.resumeState.map((s) => ({
        index: s.index,
        start: s.start,
        end: s.end,
        downloaded: s.downloaded,
        complete: s.complete,
        tempFile: s.tempFile || path.join(this.tempDir, `chunk_${s.index}.tmp`),
      }));
      this.downloaded = this.chunks.reduce((a, c) => a + c.downloaded, 0);
      return;
    }

    const effectiveChunks = Math.min(
      this.numChunks,
      Math.floor(this.fileSize / MIN_CHUNK_SIZE) || 1
    );
    const chunkSize = Math.floor(this.fileSize / effectiveChunks);

    this.chunks = [];
    for (let i = 0; i < effectiveChunks; i++) {
      const start = i * chunkSize;
      const end = i === effectiveChunks - 1 ? this.fileSize - 1 : start + chunkSize - 1;
      this.chunks.push({
        index: i,
        start,
        end,
        downloaded: 0,
        complete: false,
        tempFile: path.join(this.tempDir, `chunk_${i}_${Date.now()}.tmp`),
      });
    }
  }

  async _downloadAllChunks() {
    const pending = this.chunks.filter((c) => !c.complete);

    await Promise.all(
      pending.map((chunk) => this._downloadChunk(chunk))
    );

    // Attempt byte-stealing for any remaining incomplete chunks
    await this._stealBytes();
  }

  _downloadChunk(chunk) {
    return new Promise((resolve, reject) => {
      if (this._aborted || this._paused || chunk.complete) {
        resolve();
        return;
      }

      const byteStart = chunk.start + chunk.downloaded;
      const byteEnd = chunk.end;

      if (byteStart > byteEnd) {
        chunk.complete = true;
        resolve();
        return;
      }

      const parsed = new URL(this.url);
      const mod = parsed.protocol === 'https:' ? https : http;

      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers: {
          ...this.headers,
          Range: `bytes=${byteStart}-${byteEnd}`,
        },
        timeout: CONNECT_TIMEOUT,
      };

      const req = mod.get(options, (res) => {
        if (res.statusCode !== 206 && res.statusCode !== 200) {
          reject(new Error(`Unexpected status ${res.statusCode} for chunk ${chunk.index}`));
          return;
        }

        const writeStream = fs.createWriteStream(chunk.tempFile, {
          flags: chunk.downloaded > 0 ? 'a' : 'w',
        });

        let readTimer = setTimeout(() => req.destroy(new Error('Read timeout')), READ_TIMEOUT);

        res.on('data', (data) => {
          clearTimeout(readTimer);
          readTimer = setTimeout(() => req.destroy(new Error('Read timeout')), READ_TIMEOUT);

          chunk.downloaded += data.length;
          this.downloaded += data.length;
          this.speedTracker.update(data.length);

          this._emitProgress();
        });

        res.on('end', () => {
          clearTimeout(readTimer);
          writeStream.end();
          chunk.complete = true;
          this.activeRequests.delete(chunk.index);
          resolve();
        });

        res.on('error', (err) => {
          clearTimeout(readTimer);
          writeStream.destroy();
          this.activeRequests.delete(chunk.index);
          reject(err);
        });

        res.pipe(writeStream);
      });

      req.on('error', (err) => {
        this.activeRequests.delete(chunk.index);
        reject(err);
      });

      req.on('timeout', () => {
        req.destroy(new Error(`Connect timeout on chunk ${chunk.index}`));
      });

      this.activeRequests.set(chunk.index, req);
    });
  }

  /**
   * Byte stealing: find the slowest / largest incomplete chunk and split
   * its remaining bytes into faster workers.
   */
  async _stealBytes() {
    const incomplete = this.chunks.filter((c) => !c.complete);
    if (incomplete.length === 0) return;

    for (const chunk of incomplete) {
      const remaining = (chunk.end - chunk.start) - chunk.downloaded;
      const total = chunk.end - chunk.start + 1;
      const fraction = remaining / total;

      if (fraction > STEAL_THRESHOLD && remaining > MIN_CHUNK_SIZE * 2) {
        // Split the remaining portion into two halves
        const splitPoint = chunk.start + chunk.downloaded + Math.floor(remaining / 2);

        const newChunk = {
          index: this.chunks.length,
          start: splitPoint + 1,
          end: chunk.end,
          downloaded: 0,
          complete: false,
          tempFile: path.join(this.tempDir, `chunk_${this.chunks.length}_${Date.now()}.tmp`),
        };

        // Shrink the original chunk's range
        chunk.end = splitPoint;

        this.chunks.push(newChunk);
        await this._downloadChunk(newChunk);
      } else {
        await this._downloadChunk(chunk);
      }
    }
  }

  async _streamDownload() {
    return new Promise((resolve, reject) => {
      if (this._aborted) return reject(new Error('Aborted'));

      const parsed = new URL(this.url);
      const mod = parsed.protocol === 'https:' ? https : http;

      const writeStream = fs.createWriteStream(this.outputFile);

      const req = mod.get(
        { hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: parsed.pathname + parsed.search, headers: this.headers },
        (res) => {
          this.fileSize = parseInt(res.headers['content-length'] || '0', 10);

          res.on('data', (chunk) => {
            this.downloaded += chunk.length;
            this.speedTracker.update(chunk.length);
            this._emitProgress();
          });

          res.pipe(writeStream);

          res.on('end', () => {
            this.emit('complete', { outputFile: this.outputFile });
            resolve();
          });

          res.on('error', reject);
        }
      );

      req.on('error', reject);
    });
  }

  async _mergeChunks() {
    // Sort chunks by original order (some may have been split)
    const sorted = [...this.chunks].sort((a, b) => a.start - b.start);

    const writeStream = fs.createWriteStream(this.outputFile);

    for (const chunk of sorted) {
      await new Promise((resolve, reject) => {
        if (!fs.existsSync(chunk.tempFile)) {
          // Chunk was a stolen sub-range that may be handled elsewhere
          resolve();
          return;
        }
        const rs = fs.createReadStream(chunk.tempFile);
        rs.pipe(writeStream, { end: false });
        rs.on('end', resolve);
        rs.on('error', reject);
      });
    }

    await new Promise((resolve) => writeStream.end(resolve));

    this._cleanupTempFiles();
    this.emit('complete', { outputFile: this.outputFile });
  }

  _cleanupTempFiles() {
    for (const chunk of this.chunks) {
      if (chunk.tempFile && fs.existsSync(chunk.tempFile)) {
        try { fs.unlinkSync(chunk.tempFile); } catch (_) {}
      }
    }
  }

  _emitProgress() {
    const speed = this.speedTracker.getSpeed();
    const progress = this.fileSize > 0
      ? Math.min(100, (this.downloaded / this.fileSize) * 100)
      : 0;
    const eta = speed > 0 && this.fileSize > 0
      ? Math.ceil((this.fileSize - this.downloaded) / speed)
      : 0;

    this.emit('progress', {
      downloaded: this.downloaded,
      total: this.fileSize,
      speed,
      progress,
      eta,
    });
  }
}

module.exports = ChunkEngine;
