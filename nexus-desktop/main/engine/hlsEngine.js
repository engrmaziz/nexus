'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const { Parser: M3U8Parser } = require('m3u8-parser');
const pLimit = require('p-limit');
const MergeEngine = require('./mergeEngine');
const SpeedTracker = require('./speedTracker');
const logger = require('../utils/logger');

const SEGMENT_CONCURRENCY = 12;
const SEGMENT_RETRIES     = 3;
const LIVE_POLL_INTERVAL  = 2000;
const LIVE_MAX_SEGMENTS   = 10000;
const FETCH_TIMEOUT       = 20_000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve a potentially relative URI against a base URL.
 */
function resolveUrl(uri, base) {
  if (/^https?:\/\//i.test(uri)) return uri;
  const b = new URL(base);
  if (uri.startsWith('//')) return `${b.protocol}${uri}`;
  if (uri.startsWith('/')) return `${b.protocol}//${b.host}${uri}`;
  const dir = b.pathname.split('/').slice(0, -1).join('/');
  return `${b.protocol}//${b.host}${dir}/${uri}`;
}

/** GET as text, follows one level of redirect. */
function fetchText(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(
      url,
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NexusDownloader/1.0)', ...extraHeaders }, timeout: FETCH_TIMEOUT },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(fetchText(res.headers.location, extraHeaders));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
        res.on('error', reject);
      }
    ).on('error', reject)
     .on('timeout', function () { this.destroy(new Error(`Timeout fetching ${url}`)); });
  });
}

/** GET as Buffer, with retries, follows one level of redirect. */
async function fetchBuffer(url, extraHeaders = {}, retries = SEGMENT_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const buf = await _fetchBufferOnce(url, extraHeaders);
      return buf;
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = 500 * Math.pow(2, attempt);
      logger.warn(`Segment fetch failed (attempt ${attempt + 1}/${retries + 1}), retry in ${delay}ms`, { url, err: err.message });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

function _fetchBufferOnce(url, extraHeaders) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(
      url,
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NexusDownloader/1.0)', ...extraHeaders }, timeout: FETCH_TIMEOUT },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(_fetchBufferOnce(res.headers.location, extraHeaders));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        }
        const bufs = [];
        res.on('data', (c) => bufs.push(c));
        res.on('end', () => resolve(Buffer.concat(bufs)));
        res.on('error', reject);
      }
    ).on('error', reject)
     .on('timeout', function () { this.destroy(new Error(`Timeout fetching ${url}`)); });
  });
}

// ─── HlsEngine ────────────────────────────────────────────────────────────────

/**
 * HlsEngine – downloads an HLS stream (.m3u8), decrypts AES-128 segments,
 * and merges them using FFmpeg.
 *
 * Emits: 'progress' { downloaded, total, speed, progress, eta }
 *        'complete'
 *        'error' Error
 */
class HlsEngine extends EventEmitter {
  /**
   * @param {object}  opts
   * @param {string}  opts.url          Master or media playlist URL.
   * @param {string}  opts.outputFile   Final output file path.
   * @param {string}  opts.tempDir      Directory for temp segment files.
   * @param {object}  [opts.headers]    Extra HTTP headers.
   * @param {string}  [opts.quality]    'best' (default) or target bandwidth.
   */
  constructor(opts) {
    super();
    this.url = opts.url;
    this.outputFile = opts.outputFile;
    this.tempDir = opts.tempDir;
    this.headers = opts.headers || {};
    this.quality = opts.quality || 'best';
    this._aborted = false;
    this._paused = false;
    this.speedTracker = new SpeedTracker();
    this._segments = [];
    this._completedSegments = 0;
    this._totalSegments = 0;
    this._keyCache = new Map(); // key URI → Buffer
  }

  async start() {
    try {
      await fs.promises.mkdir(this.tempDir, { recursive: true });
      const manifest = await fetchText(this.url, this.headers);
      const parser = new M3U8Parser();
      parser.push(manifest);
      parser.end();
      const parsed = parser.manifest;

      // Master playlist → pick variant
      if (parsed.playlists && parsed.playlists.length > 0) {
        const variant = this._selectVariant(parsed.playlists);
        const variantUrl = resolveUrl(variant.uri, this.url);
        await this._downloadMediaPlaylist(variantUrl);
      } else {
        await this._downloadMediaPlaylist(this.url);
      }
    } catch (err) {
      if (!this._aborted) this.emit('error', err);
    }
  }

  pause()  { this._paused = true; }
  resume() { this._paused = false; }
  abort()  { this._aborted = true; this._paused = true; }

  // ─── Internals ────────────────────────────────────────────────────────

  _selectVariant(playlists) {
    const sorted = [...playlists].sort(
      (a, b) => (b.attributes?.BANDWIDTH || 0) - (a.attributes?.BANDWIDTH || 0)
    );
    return sorted[0];
  }

  async _downloadMediaPlaylist(playlistUrl) {
    // For live streams we poll; for VOD we parse once
    let segmentFiles = [];
    let isLive = false;

    const loadPlaylist = async () => {
      const text = await fetchText(playlistUrl, this.headers);
      const p = new M3U8Parser();
      p.push(text);
      p.end();
      const m = p.manifest;
      isLive = !m.endList;
      const newSegs = (m.segments || []).map((s) => ({
        ...s,
        resolvedUri: resolveUrl(s.uri, playlistUrl),
      }));
      return newSegs;
    };

    this._segments = await loadPlaylist();
    let segmentOffset = 0;

    if (isLive) {
      // Live: keep polling until we hit the cap
      let totalCap = 0;
      while (!this._aborted && totalCap < LIVE_MAX_SEGMENTS) {
        const newSegs = this._segments.slice(segmentOffset);
        if (newSegs.length > 0) {
          const downloaded = await this._downloadSegments(newSegs, segmentOffset, segmentFiles.length);
          segmentFiles = segmentFiles.concat(downloaded);
          segmentOffset = this._segments.length;
          totalCap += downloaded.length;
        }
        if (this._aborted) break;
        await new Promise((r) => setTimeout(r, LIVE_POLL_INTERVAL));
        // Re-fetch playlist to discover new segments
        const refreshed = await loadPlaylist();
        for (const seg of refreshed) {
          if (!this._segments.some((s) => s.resolvedUri === seg.resolvedUri)) {
            this._segments.push(seg);
          }
        }
        if (!isLive) break; // endList appeared
      }
    } else {
      this._totalSegments = this._segments.length;
      if (this._totalSegments === 0) throw new Error('No segments found in HLS playlist');
      segmentFiles = await this._downloadSegments(this._segments, 0, 0);
    }

    // Merge segments
    const merger = new MergeEngine();
    await merger.concatSegments(segmentFiles, this.outputFile);

    this._cleanup(segmentFiles);
    this.emit('complete');
  }

  async _downloadSegments(segments, globalOffset, existingCount) {
    const limit = pLimit(SEGMENT_CONCURRENCY);
    const segmentFiles = [];

    const tasks = segments.map((seg, localIdx) => {
      const globalIdx = globalOffset + localIdx;
      const outFile = path.join(this.tempDir, `seg_${String(existingCount + localIdx).padStart(6, '0')}.ts`);
      segmentFiles[localIdx] = outFile;

      return limit(async () => {
        if (this._aborted) return;

        // Wait if paused
        while (this._paused && !this._aborted) {
          await new Promise((r) => setTimeout(r, 300));
        }
        if (this._aborted) return;

        // Skip already-downloaded segment
        if (fs.existsSync(outFile)) {
          this._completedSegments++;
          return;
        }

        let data = await fetchBuffer(seg.resolvedUri, this.headers);

        // AES-128 decryption
        if (seg.key && seg.key.method === 'AES-128') {
          data = await this._decryptSegment(data, seg.key, globalIdx);
        }

        fs.writeFileSync(outFile, data);
        this._completedSegments++;
        this.speedTracker.addSample(data.length);

        const total = this._totalSegments || segments.length;
        const progress = (this._completedSegments / total) * 100;
        const speed = this.speedTracker.getSpeed();
        const eta = speed > 0 && total > 0
          ? Math.ceil(((total - this._completedSegments) * (data.length)) / speed)
          : 0;

        this.emit('progress', {
          downloaded: this._completedSegments,
          total,
          speed,
          progress: Math.min(100, progress),
          eta,
        });
      });
    });

    await Promise.all(tasks);
    return segmentFiles;
  }

  async _decryptSegment(data, keyInfo, segIdx) {
    const keyUri = resolveUrl(keyInfo.uri, this.url);

    // Cache keys to avoid re-fetching
    let keyBuf = this._keyCache.get(keyUri);
    if (!keyBuf) {
      keyBuf = await fetchBuffer(keyUri, this.headers);
      this._keyCache.set(keyUri, keyBuf);
    }

    // IV: explicit from playlist or segment sequence number as 16-byte big-endian
    let iv;
    if (keyInfo.iv) {
      iv = Buffer.from(keyInfo.iv.replace(/^0x/i, ''), 'hex');
    } else {
      iv = Buffer.alloc(16);
      iv.writeUInt32BE(segIdx, 12);
    }

    const decipher = crypto.createDecipheriv('aes-128-cbc', keyBuf, iv);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  }

  _cleanup(files) {
    for (const f of files) {
      try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
    }
  }
}

module.exports = HlsEngine;
